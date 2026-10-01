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
import { streamPlanOf } from './egress-stream.ts';
import type { GivenUrls } from './egress-urls.ts';
import { TheoremError } from './error.ts';
import { guardrailFromHits, guardrailFromVerdict } from './events.ts';
import { lexiconText } from './lexicon.ts';
import { resolveGuardrailPolicy } from './policy.ts';
import {
  createOutboundProgressiveGate,
  LIVE_DEFAULT_HOLDBACK,
  type ProgressiveYieldGate,
  type ProgressiveYieldResult,
} from './progressive-yield.ts';
import { type ThoughtGuard, type ThoughtRelease, thoughtGuardFor } from './thought-guard.ts';
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
  /** Omits what in the session's thoughts leaks; carries from one cycle to the next. */
  thoughts?: ThoughtGuard;
}

export type LiveOutboundBatchResult =
  | { action: 'emit'; events: TurnEvent[] }
  | { action: 'withhold'; error: TheoremError; events?: TurnEvent[] }
  | { action: 'idle' };

const UNTRANSCRIBED_HIT: GuardrailHit = { rule: 'live.untranscribed-audio', severity: 'high' };

function egressSpec(session: LiveOutboundGateSession): ProfileEgressSpec | undefined {
  return session.policy.egress;
}

/**
 * The policy with Live's shorter default lookback when a host enforcer set
 * none: every held character of transcript holds its audio. The bundled policy
 * holds exactly and takes no lookback.
 */
function liveHoldback(policy: ResolvedGuardrailPolicy): ResolvedGuardrailPolicy {
  if (
    !policy.egress ||
    policy.egress.holdback !== undefined ||
    streamPlanOf(policy.egress.enforce)
  ) {
    return policy;
  }
  return { ...policy, egress: { ...policy.egress, holdback: LIVE_DEFAULT_HOLDBACK } };
}

/** A canary is attached only when the profile policy enables it and the caller supplied a token. */
function createLiveOutboundGateSession(
  profile: Profile,
  canary?: string,
  system?: string,
  givenUrls?: GivenUrls,
): LiveOutboundGateSession {
  const policy = liveHoldback(resolveGuardrailPolicy(profile.guardrails));
  const useCanary = policy.canary && Boolean(canary);
  const context: GuardrailContext = {
    stage: 'live_outbound',
    trust: 'untrusted',
    profileId: profile.id,
    ...(useCanary ? { canary } : {}),
    // The system prompt is guarded against echo alongside the canary that binds it.
    ...(useCanary && policy.promptEcho && system ? { system } : {}),
    ...(profile.lexicon ? { lexicon: profile.lexicon } : {}),
    ...(givenUrls ? { givenUrls } : {}),
  };
  const thoughts = thoughtGuardFor(policy.egress?.enforce, context);
  return {
    policy,
    context,
    gate: createOutboundProgressiveGate(policy, context),
    held: [],
    releasedTo: 0,
    withholdVisible: false,
    ...(thoughts ? { thoughts } : {}),
  };
}

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

/** Media waits behind the reply before it, so speech is heard only after its transcript clears the scan. */
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

    if (event.type === 'thought' && session.thoughts) {
      toEmit.push(...thoughtEvents(session.thoughts.push(event.text), event));
      continue;
    }
    toEmit.push(event);
  }

  return emitOrIdle(toEmit);
}

/** What a thought guard released, after the event saying what it omitted from it. */
function thoughtEvents({ text, hits }: ThoughtRelease, event: TurnEventOf<'thought'>): TurnEvent[] {
  const guardrail = guardrailFromHits('thought', 'untrusted', hits, 'redact');
  return [...(guardrail ? [guardrail] : []), ...(text ? [{ ...event, text }] : [])];
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
 * Live has no repair loop. Allow releases what is still held; redact and refuse replace it with
 * text (held audio is dropped); block withholds it as a `safety` error.
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

/** Call once after the provider has finished the cycle; it also starts the next one. */
async function finalizeLiveOutboundTurn(
  session: LiveOutboundGateSession,
): Promise<LiveOutboundBatchResult> {
  if (!session.gate) {
    return { action: 'idle' };
  }
  const thought = session.thoughts
    ? thoughtEvents(session.thoughts.flush(), { type: 'thought', text: '' })
    : [];
  const result = await finalizeCycle(session, session.gate);
  resetCycle(session);
  if (thought.length === 0) return result;
  if (result.action === 'idle') return { action: 'emit', events: thought };
  return { ...result, events: [...thought, ...(result.events ?? [])] };
}

/** Drop the cycle's held output when the user interrupts mid-turn. */
function abortLiveOutboundTurn(session: LiveOutboundGateSession): void {
  session.thoughts?.flush();
  resetCycle(session);
}

export {
  abortLiveOutboundTurn,
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  processLiveOutboundBatch,
};
