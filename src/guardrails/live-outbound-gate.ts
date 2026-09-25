/**
 * Stateful Live outbound gate — progressive-yield canary + egress lookback.
 *
 * Matches runTurn semantics:
 *   • the reply stream (text deltas and the spoken-reply transcript) is held in
 *     the progressive-yield lookback; thoughts are unguarded (`isGuardedOutput`)
 *   • audio and other media wait behind the reply that preceded them, so speech
 *     is heard only after its transcript clears the scan
 *   • any other event releases what is held (in order), then passes after a
 *     whole-event canary scan
 *   • canary-only profiles withhold immediately on leak
 *   • with egress.enforce, a hit withholds the rest of the cycle; finalize
 *     releases it (allow), rewrites it (redact), or refuses/withholds it (block)
 *
 * Scope is one conversational cycle: finalize and abort start the next one.
 * Live has no repair loop — a blocked turn is refuse_to_user copy, or withheld
 * (a `safety` error).
 *
 * @module
 */

import type { Profile, TurnEvent } from '../kernel/types.ts';
import { eventHasCanary, isStreamedCanaryEvent } from './canary.ts';
import { CANARY_HIT, runEnforcer, WITHHELD_REASON } from './egress.ts';
import { TheoremError } from './error.ts';
import { guardrailFromHits, guardrailFromVerdict } from './events.ts';
import { lexiconText } from './lexicon.ts';
import { resolveGuardrailPolicy } from './policy.ts';
import {
  createOutboundProgressiveGate,
  type ProgressiveYieldGate,
  type ProgressiveYieldResult,
} from './progressive-yield.ts';
import type {
  GuardrailContext,
  GuardrailHit,
  ProfileEgressSpec,
  ResolvedGuardrailPolicy,
} from './types.ts';

/**
 * One piece of output not yet released: a reply-stream chunk covering
 * `[start, end)` of the gate's window, or media (`start === end`) that waits
 * until the reply before it has cleared.
 */
export interface LiveHeldOutput {
  event: TurnEvent;
  start: number;
  end: number;
}

/**
 * Mutable outbound guardrail state for one live session. It retains the
 * cycle's progressive stream state and the output still held back.
 */
export interface LiveOutboundGateSession {
  policy: ResolvedGuardrailPolicy;
  context: GuardrailContext;
  gate: ProgressiveYieldGate | null;
  /** Reply chunks and media not yet released, in arrival order. */
  held: LiveHeldOutput[];
  /** Window offset the host has received reply text up to. */
  releasedTo: number;
  /** Stop releasing held output after a progressive egress hit. */
  withholdVisible: boolean;
}

/** Result of a live outbound operation: events to emit, output to withhold, or no work. */
export type LiveOutboundBatchResult =
  | { action: 'emit'; events: TurnEvent[] }
  | { action: 'withhold'; error: TheoremError; events?: TurnEvent[] }
  | { action: 'idle' };

function egressSpec(session: LiveOutboundGateSession): ProfileEgressSpec | undefined {
  return session.policy.egress;
}

/**
 * Creates outbound guardrail state for a live profile. A canary is only attached
 * when the resolved profile policy enables it and the caller supplied a token.
 */
function createLiveOutboundGateSession(profile: Profile, canary?: string): LiveOutboundGateSession {
  const policy = resolveGuardrailPolicy(profile.guardrails);
  const useCanary = policy.canary && Boolean(canary);
  const context: GuardrailContext = {
    stage: 'live_outbound',
    trust: 'untrusted',
    profileId: profile.id,
    ...(useCanary ? { canary } : {}),
    ...(profile.lexicon ? { lexicon: profile.lexicon } : {}),
  };
  return {
    policy,
    context,
    gate: createOutboundProgressiveGate(policy, context),
    held: [],
    releasedTo: 0,
    withholdVisible: false,
  };
}

/** Start the next cycle: fresh window, nothing held, nothing withheld. */
function resetCycle(session: LiveOutboundGateSession): void {
  session.gate = createOutboundProgressiveGate(session.policy, session.context);
  session.held = [];
  session.releasedTo = 0;
  session.withholdVisible = false;
}

/** Canary-only profiles stop the turn immediately; egress profiles defer to finalize. */
function canaryOnlyImmediateWithhold(session: LiveOutboundGateSession): boolean {
  return !egressSpec(session)?.enforce;
}

function withholdResult(
  reason: string,
  hits: GuardrailHit[],
  prior: TurnEvent[] = [],
): LiveOutboundBatchResult {
  const guardrail = guardrailFromHits('live_outbound', 'untrusted', hits, 'block');
  return {
    action: 'withhold',
    error: new TheoremError('safety', reason),
    events: [...prior, ...(guardrail ? [guardrail] : [])],
  };
}

/** Window offset the gate has cleared for release. */
function clearedTo(gate: ProgressiveYieldGate): number {
  return gate.accumulated().length - gate.unreleased().length;
}

/**
 * Release held output up to window offset `to`: reply chunks as far as they
 * reach, media once everything before it is out. Stops at the first item that
 * cannot go yet, so the host sees output in arrival order.
 */
function releaseHeld(
  session: LiveOutboundGateSession,
  gate: ProgressiveYieldGate,
  to: number,
  into: TurnEvent[],
): void {
  const window = gate.accumulated();
  for (let item = session.held[0]; item !== undefined; item = session.held[0]) {
    const from = Math.max(item.start, session.releasedTo);
    const upTo = Math.min(item.end, to);
    if (upTo > from) {
      into.push({ ...item.event, text: window.slice(from, upTo) });
      session.releasedTo = upTo;
    }
    if (item.end > to) {
      return;
    }
    if (item.start === item.end) {
      into.push(item.event);
    }
    session.held.shift();
  }
}

/**
 * Apply a progressive scan result. Clean: release what the gate cleared.
 * Blocked: canary-only withholds the session; egress withholds the rest of
 * the cycle and reports the hit. `undefined` means keep going.
 */
function applyScan(
  session: LiveOutboundGateSession,
  gate: ProgressiveYieldGate,
  result: ProgressiveYieldResult,
  into: TurnEvent[],
): LiveOutboundBatchResult | undefined {
  if (!result.blocked) {
    releaseHeld(session, gate, clearedTo(gate), into);
    return undefined;
  }
  if (canaryOnlyImmediateWithhold(session)) {
    return withholdResult(WITHHELD_REASON.canary, result.hits, into);
  }
  session.withholdVisible = true;
  const guardrail = guardrailFromHits('live_outbound', 'untrusted', result.hits, 'block');
  if (guardrail) {
    into.push(guardrail);
  }
  return undefined;
}

/** Scan and release everything held (a non-reply event, or the end of the cycle). */
async function flushHeld(
  session: LiveOutboundGateSession,
  gate: ProgressiveYieldGate,
  into: TurnEvent[],
): Promise<LiveOutboundBatchResult | undefined> {
  if (session.withholdVisible || session.held.length === 0) {
    return undefined;
  }
  return applyScan(session, gate, await gate.flush(), into);
}

/** Hold one media event behind the reply before it; it goes as soon as that has cleared. */
function holdMedia(
  session: LiveOutboundGateSession,
  gate: ProgressiveYieldGate,
  event: TurnEvent,
  into: TurnEvent[],
): void {
  const at = gate.accumulated().length;
  session.held.push({ event, start: at, end: at });
  if (!session.withholdVisible) {
    releaseHeld(session, gate, clearedTo(gate), into);
  }
}

async function holdStreamChunk(
  session: LiveOutboundGateSession,
  gate: ProgressiveYieldGate,
  event: TurnEvent,
  into: TurnEvent[],
): Promise<LiveOutboundBatchResult | undefined> {
  const text = event.text ?? '';
  if (!text) {
    return undefined;
  }
  const start = gate.accumulated().length;
  session.held.push({ event, start, end: start + text.length });
  const result = await gate.process(text);
  if (session.withholdVisible) {
    // Keep feeding the window so finalize judges the whole cycle.
    return undefined;
  }
  return applyScan(session, gate, result, into);
}

/** Process one upstream Live batch (may emit immediately or hold lookback). */
async function processLiveOutboundBatch(
  session: LiveOutboundGateSession,
  events: TurnEvent[],
): Promise<LiveOutboundBatchResult> {
  const toEmit: TurnEvent[] = [];
  const { gate } = session;
  if (!gate) {
    return emitOrIdle(events);
  }

  for (const event of events) {
    if (isStreamedCanaryEvent(event)) {
      const stopped = await holdStreamChunk(session, gate, event, toEmit);
      if (stopped) {
        return stopped;
      }
      continue;
    }

    if (event.type === 'media') {
      holdMedia(session, gate, event, toEmit);
      continue;
    }

    const stopped = await flushHeld(session, gate, toEmit);
    if (stopped) {
      return stopped;
    }

    if (session.context.canary && eventHasCanary(event, session.context.canary)) {
      return withholdResult(WITHHELD_REASON.canary, [CANARY_HIT], toEmit);
    }

    toEmit.push(event);
  }

  return emitOrIdle(toEmit);
}

function emitOrIdle(events: TurnEvent[]): LiveOutboundBatchResult {
  return events.length === 0 ? { action: 'idle' } : { action: 'emit', events };
}

/**
 * End-of-cycle egress verdict on the cycle's whole reply. Allow releases what
 * is still held; redact and refuse replace it with text (held audio is
 * dropped); block withholds it.
 */
async function finalEgressVerdict(
  session: LiveOutboundGateSession,
  gate: ProgressiveYieldGate,
  egress: ProfileEgressSpec,
  prior: TurnEvent[],
): Promise<LiveOutboundBatchResult> {
  const verdict = await runEnforcer(egress.enforce, { text: gate.accumulated() }, session.context);
  const guardrail = guardrailFromVerdict('live_outbound', 'untrusted', verdict);
  const events = [...prior, ...(guardrail ? [guardrail] : [])];

  if (verdict.action === 'redact') {
    return { action: 'emit', events: [...events, { type: 'text', text: verdict.text }] };
  }
  if (verdict.action === 'block') {
    if (egress.onBlock === 'refuse_to_user') {
      const text = lexiconText('egress.refusal', {}, session.context.lexicon);
      return { action: 'emit', events: [...events, { type: 'text', text }] };
    }
    return withholdResult(WITHHELD_REASON.egress, verdict.hits, prior);
  }
  releaseHeld(session, gate, gate.accumulated().length, events);
  return emitOrIdle(events);
}

async function finalizeCycle(
  session: LiveOutboundGateSession,
  gate: ProgressiveYieldGate,
): Promise<LiveOutboundBatchResult> {
  const events: TurnEvent[] = [];
  const stopped = await flushHeld(session, gate, events);
  if (stopped) {
    return stopped;
  }
  const egress = egressSpec(session);
  if (egress && gate.accumulated()) {
    return await finalEgressVerdict(session, gate, egress, events);
  }
  return emitOrIdle(events);
}

/**
 * Releases held output and applies the final egress decision at the end of a
 * live cycle, then starts the next cycle. Call once after the provider has
 * finished the cycle.
 */
async function finalizeLiveOutboundTurn(
  session: LiveOutboundGateSession,
): Promise<LiveOutboundBatchResult> {
  if (!session.gate) {
    return { action: 'idle' };
  }
  const result = await finalizeCycle(session, session.gate);
  resetCycle(session);
  return result;
}

/** Drop the cycle's held output when the user interrupts mid-turn. */
function abortLiveOutboundTurn(session: LiveOutboundGateSession): void {
  resetCycle(session);
}

export {
  abortLiveOutboundTurn,
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  processLiveOutboundBatch,
};
