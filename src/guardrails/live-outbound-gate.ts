/**
 * Stateful Live outbound gate — progressive-yield canary + egress lookback.
 *
 * Matches runTurn semantics:
 *   • the reply stream (text deltas and the spoken-reply transcript) is held in
 *     the progressive-yield lookback; thoughts are unguarded (`isGuardedOutput`)
 *   • audio and other media stream behind the transcript: Google sends a
 *     chunk's transcript in the same message, so a chunk is covered by the
 *     transcript its message carries, or — in a message without one — by the
 *     next transcript chunk to arrive. It goes once the gate has cleared that
 *     chunk. `generation_complete` covers the rest (the transcript is whole);
 *     audio in a cycle with no transcript is dropped (fail closed)
 *   • any other event releases the reply held before it, then passes after a
 *     whole-event canary scan
 *   • output released before a later hit is not recalled: audio, like text, is
 *     withheld from the hit onward
 *   • canary-only profiles withhold immediately on leak
 *   • with egress.enforce, a hit withholds the rest of the cycle; finalize
 *     releases it (allow), rewrites it (redact), or refuses/withholds it (block)
 *
 * Scope is one conversational cycle: finalize and abort start the next one,
 * which reads the last cycle's possible canary opening in front of its own.
 * Live has no repair loop — a blocked turn is refuse_to_user copy, or withheld
 * (a `safety` error).
 *
 * @module
 */

import type { TurnEventOf } from '../kernel/turn-events.ts';
import type { Profile, TurnEvent } from '../kernel/types.ts';
import { isStreamedCanaryEvent, type StreamedReplyEvent } from './canary.ts';
import {
  eventPromptLeakHits,
  isPromptLeakHit,
  promptLeakReason,
  runEnforcer,
  WITHHELD_REASON,
} from './egress.ts';
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
  Verdict,
} from './types.ts';

/**
 * One piece of output not yet released: a reply-stream chunk covering
 * `[start, end)` of the gate's window, or media arriving at `start`, whose
 * `end` is where its covering transcript ends (`Infinity` until one arrives).
 */
export interface LiveHeldOutput {
  event: StreamedReplyEvent | TurnEventOf<'media'>;
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
  /**
   * System-prompt leaks this cycle withheld under a host policy. They pin the
   * cycle's final verdict to block: no host verdict may release them.
   */
  promptLeaks?: GuardrailHit[];
}

/** Result of a live outbound operation: events to emit, output to withhold, or no work. */
export type LiveOutboundBatchResult =
  | { action: 'emit'; events: TurnEvent[] }
  | { action: 'withhold'; error: TheoremError; events?: TurnEvent[] }
  | { action: 'idle' };

const UNTRANSCRIBED_HIT: GuardrailHit = { rule: 'live.untranscribed-audio', severity: 'high' };

function egressSpec(session: LiveOutboundGateSession): ProfileEgressSpec | undefined {
  return session.policy.egress;
}

/**
 * Creates outbound guardrail state for a live profile. A canary is only attached
 * when the resolved profile policy enables it and the caller supplied a token.
 */
function createLiveOutboundGateSession(
  profile: Profile,
  canary?: string,
  system?: string,
): LiveOutboundGateSession {
  const policy = resolveGuardrailPolicy(profile.guardrails);
  const useCanary = policy.canary && Boolean(canary);
  const context: GuardrailContext = {
    stage: 'live_outbound',
    trust: 'untrusted',
    profileId: profile.id,
    ...(useCanary ? { canary } : {}),
    // The system prompt is guarded against echo alongside the canary that binds it.
    ...(useCanary && policy.promptEcho && system ? { system } : {}),
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

/**
 * Start the next cycle: fresh window, nothing held, nothing withheld. The
 * session canary is stable, so the next window reads this one's possible
 * leak opening in front of its own (`canaryCarry`).
 */
function resetCycle(session: LiveOutboundGateSession): void {
  const carry = session.gate?.carryOut();
  session.gate = createOutboundProgressiveGate(session.policy, session.context, carry);
  session.held = [];
  session.releasedTo = 0;
  session.withholdVisible = false;
  session.promptLeaks = undefined;
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
 * reach, media once the transcript covering it is cleared — or all of it when
 * the transcript is whole. Stops at the first item that cannot go yet, so the
 * host sees output in arrival order.
 */
function releaseHeld(
  session: LiveOutboundGateSession,
  gate: ProgressiveYieldGate,
  to: number,
  into: TurnEvent[],
  transcriptWhole = false,
): void {
  const window = gate.accumulated();
  for (let item = session.held[0]; item !== undefined; item = session.held[0]) {
    const { event } = item;
    if (event.type !== 'media') {
      const from = Math.max(item.start, session.releasedTo);
      const upTo = Math.min(item.end, to);
      if (upTo > from) {
        into.push({ ...event, text: window.slice(from, upTo) });
        session.releasedTo = upTo;
      }
    }
    if (item.end > to && !(transcriptWhole && event.type === 'media')) {
      return;
    }
    if (event.type === 'media') {
      into.push(event);
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
    return withholdResult(promptLeakReason(result.hits), result.hits, into);
  }
  const leaks = result.hits.filter(isPromptLeakHit);
  if (leaks.length > 0) {
    session.promptLeaks = leaks;
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

/**
 * Hold one media event behind the reply before it. Its message's transcript,
 * already in the window, covers it; without one it waits for the next.
 */
function holdMedia(
  session: LiveOutboundGateSession,
  gate: ProgressiveYieldGate,
  event: TurnEventOf<'media'>,
  transcribed: boolean,
): void {
  const at = gate.accumulated().length;
  session.held.push({ event, start: at, end: transcribed ? at : Number.POSITIVE_INFINITY });
}

/** The media still waiting for a transcript chunk is covered by this one. */
function coverMedia(session: LiveOutboundGateSession, end: number): void {
  for (let i = session.held.length - 1; i >= 0; i -= 1) {
    const item = session.held[i];
    if (item === undefined || item.end !== Number.POSITIVE_INFINITY) {
      return;
    }
    item.end = end;
  }
}

async function holdStreamChunk(
  session: LiveOutboundGateSession,
  gate: ProgressiveYieldGate,
  event: StreamedReplyEvent,
  into: TurnEvent[],
): Promise<LiveOutboundBatchResult | undefined> {
  const text = event.text ?? '';
  if (!text) {
    return undefined;
  }
  const start = gate.accumulated().length;
  coverMedia(session, start + text.length);
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

  // One batch is one provider message: its transcript is its audio's.
  let transcribed = false;
  for (const event of events) {
    if (isStreamedCanaryEvent(event)) {
      transcribed ||= Boolean(event.text);
      const stopped = await holdStreamChunk(session, gate, event, toEmit);
      if (stopped) {
        return stopped;
      }
      continue;
    }

    if (event.type === 'media') {
      holdMedia(session, gate, event, transcribed);
      // Media not yet held until the next event can release it now.
      if (!session.withholdVisible) releaseHeld(session, gate, clearedTo(gate), toEmit);
      continue;
    }

    const stopped = await flushHeld(session, gate, toEmit);
    if (stopped) {
      return stopped;
    }
    if (isGenerationComplete(event)) {
      releaseSpoken(session, gate, toEmit);
    }

    const leaks = session.context.canary
      ? eventPromptLeakHits(event, session.context.canary, session.context.system)
      : [];
    if (leaks.length > 0) {
      return withholdResult(promptLeakReason(leaks), leaks, toEmit);
    }

    toEmit.push(event);
  }

  return emitOrIdle(toEmit);
}

function isGenerationComplete(event: TurnEvent): boolean {
  return event.type === 'done' && event.stop?.kind === 'generation_complete';
}

/**
 * The model finished speaking: its transcript is whole and cleared, so the
 * audio after its last chunk goes too. A cycle with no transcript keeps its
 * audio for `dropUntranscribed`; a withheld cycle keeps it for the verdict.
 */
function releaseSpoken(
  session: LiveOutboundGateSession,
  gate: ProgressiveYieldGate,
  into: TurnEvent[],
): void {
  const whole = gate.accumulated().length;
  if (session.withholdVisible || whole === 0 || clearedTo(gate) < whole) {
    return;
  }
  releaseHeld(session, gate, whole, into, true);
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
  // The host policy adds checks; it never releases a system-prompt leak.
  const leaks = session.promptLeaks;
  const verdict: Verdict = leaks
    ? { action: 'block', hits: leaks, rejection: WITHHELD_REASON.egress }
    : await runEnforcer(egress.enforce, { text: gate.accumulated() }, session.context);
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
  releaseHeld(session, gate, gate.accumulated().length, events, true);
  return emitOrIdle(events);
}

/**
 * A cycle that held audio but produced no transcript: nothing checked the
 * audio, so it is dropped and reported, never released.
 */
function dropUntranscribed(session: LiveOutboundGateSession, events: TurnEvent[]): TurnEvent[] {
  if (session.held.length === 0) {
    return events;
  }
  const guardrail = guardrailFromHits('live_outbound', 'untrusted', [UNTRANSCRIBED_HIT], 'block');
  return guardrail ? [...events, guardrail] : events;
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
  if (!gate.accumulated()) {
    return emitOrIdle(dropUntranscribed(session, events));
  }
  const egress = egressSpec(session);
  if (egress) {
    return await finalEgressVerdict(session, gate, egress, events);
  }
  releaseHeld(session, gate, gate.accumulated().length, events, true);
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
