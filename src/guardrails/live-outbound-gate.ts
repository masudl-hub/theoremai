import type { TurnEventOf } from '../kernel/turn-events.ts';
import type { Profile, TurnEvent } from '../kernel/types.ts';
import { isStreamedCanaryEvent, type StreamedReplyEvent } from './canary.ts';
import { detectEvent } from './detect-at.ts';
import { readReply } from './detect-reply.ts';
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
import { guardrailFromHits, guardrailFromVerdict, guardrailTurnEvent } from './events.ts';
import { lexiconText } from './lexicon.ts';
import { resolveGuardrailPolicy } from './policy.ts';
import {
  createOutboundProgressiveGate,
  LIVE_DEFAULT_HOLDBACK,
  type ProgressiveYieldGate,
  type ProgressiveYieldResult,
  replyIsJudged,
} from './progressive-yield.ts';
import { type ThoughtGuard, type ThoughtRelease, thoughtGuardFor } from './thought-guard.ts';
import type { GuardrailContext, GuardrailHit, ResolvedGuardrailPolicy, Verdict } from './types.ts';

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

/** The gate's state for one live session: its policy and context, the progressive gate, the output held and how far reply text has been released. */
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

/** What the gate does with a batch of a live model's events: `emit` what is released, `withhold` with an error, or stay `idle` when nothing is released yet. */
export type LiveOutboundBatchResult =
  | { action: 'emit'; events: TurnEvent[] }
  | { action: 'withhold'; error: TheoremError; events?: TurnEvent[] }
  | { action: 'idle' };

const UNTRANSCRIBED_HIT: GuardrailHit = { rule: 'live.untranscribed-audio', severity: 'high' };

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
  privateSystem?: readonly string[],
  givenUrls?: GivenUrls,
): LiveOutboundGateSession {
  const policy = liveHoldback(resolveGuardrailPolicy(profile.guardrails));
  const useCanary = policy.canary && Boolean(canary);
  const context: GuardrailContext = {
    stage: 'live_outbound',
    trust: 'untrusted',
    profileId: profile.id,
    ...(useCanary ? { canary } : {}),
    // why: The system prompt is guarded against echo alongside the canary that binds it.
    ...(useCanary && policy.promptEcho && privateSystem?.length ? { privateSystem } : {}),
    ...(profile.lexicon ? { lexicon: profile.lexicon } : {}),
    ...(givenUrls ? { givenUrls } : {}),
  };
  const thoughts = thoughtGuardFor(policy, context);
  return {
    policy,
    context,
    gate: createOutboundProgressiveGate(policy, context, 'live_reply'),
    held: [],
    releasedTo: 0,
    withholdVisible: false,
    ...(thoughts ? { thoughts } : {}),
  };
}

function resetCycle(session: LiveOutboundGateSession): void {
  const carry = session.gate?.carryOut();
  session.gate = createOutboundProgressiveGate(
    session.policy,
    session.context,
    'live_reply',
    carry,
  );
  session.held = [];
  session.releasedTo = 0;
  session.withholdVisible = false;
  session.promptLeaks = undefined;
}

/** Whether the cycle's reply gets a verdict once it ends: a host policy runs, or a detector reads it. */
function cycleIsJudged(session: LiveOutboundGateSession): boolean {
  return replyIsJudged(session.policy, ['live_reply']);
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
 * Blocked: a cycle nothing judges later withholds the session; any other
 * withholds the rest of the cycle for its verdict. `undefined` means keep going.
 */
function applyScan(
  session: LiveOutboundGateSession,
  gate: ProgressiveYieldGate,
  result: ProgressiveYieldResult,
  into: TurnEvent[],
): LiveOutboundBatchResult | undefined {
  if (!result.blocked) {
    const found = result.found && detectEvent('live_reply', result.found);
    if (found) into.push(guardrailTurnEvent(found));
    releaseHeld(session, gate, clearedTo(gate), into);
    return undefined;
  }
  if (!cycleIsJudged(session)) {
    return withholdResult(promptLeakReason(result.hits), result.hits, into);
  }
  const leaks = result.hits.filter(isPromptLeakHit);
  if (leaks.length > 0) {
    session.promptLeaks = leaks;
  }
  session.withholdVisible = true;
  // why: A detector's stop is reported once, by the verdict on the whole reply.
  const guardrail = result.boundary
    ? undefined
    : guardrailFromHits('live_outbound', 'untrusted', result.hits, 'block');
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
    // why: Keep feeding the window so finalize judges the whole cycle.
    return undefined;
  }
  return applyScan(session, gate, result, into);
}

/** Passes one provider message's events through the outbound gate: reply text and audio are held until the egress checks clear them, a prompt leak or egress hit withholds, and thoughts go through the thought guard. */
async function processLiveOutboundBatch(
  session: LiveOutboundGateSession,
  events: TurnEvent[],
): Promise<LiveOutboundBatchResult> {
  const toEmit: TurnEvent[] = [];
  const { gate } = session;
  if (!gate) {
    return emitOrIdle(events);
  }

  // why: One batch is one provider message: its transcript is its audio's.
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
      // why: Media not yet held until the next event can release it now.
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

    const leaks = session.context.canary ? eventPromptLeakHits(event, session.context) : [];
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
function thoughtEvents(
  { text, hits, found }: ThoughtRelease,
  event: TurnEventOf<'thought'>,
): TurnEvent[] {
  const detected = found && detectEvent('thought', found);
  const guardrail = guardrailFromHits('thought', 'untrusted', hits, 'redact');
  return [
    ...(detected ? [guardrailTurnEvent(detected)] : []),
    ...(guardrail ? [guardrail] : []),
    ...(text ? [{ ...event, text }] : []),
  ];
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
 * Live has no repair loop. `guardrails.detect` reads the cycle's transcript
 * first, and a host policy judges what the detectors let through. Allow
 * releases what is still held; redact and refuse replace it with text (held
 * audio is dropped); block withholds it as a `safety` error.
 */
async function finalEgressVerdict(
  session: LiveOutboundGateSession,
  gate: ProgressiveYieldGate,
  prior: TurnEvent[],
): Promise<LiveOutboundBatchResult> {
  const { egress, detect } = session.policy;
  const read = readReply({ text: gate.accumulated() }, detect, {
    boundary: 'live_reply',
    withheld: session.withholdVisible,
  });
  // invariant: The host policy adds checks; it never releases a system-prompt leak or a detector's block.
  const stopped = session.promptLeaks ?? read.blocked;
  const verdict: Verdict = stopped
    ? { action: 'block', hits: stopped, rejection: WITHHELD_REASON.egress }
    : egress
      ? await runEnforcer(egress.enforce, read.payload, session.context)
      : { action: 'allow' };
  // why: A detector's block is reported by its own event, which names the boundary.
  const judged =
    stopped && stopped === read.blocked
      ? undefined
      : guardrailFromVerdict('live_outbound', 'untrusted', verdict);
  // why: A cycle that leaked the system prompt is reported as that alone: the canary reads as a credential.
  const detected = session.promptLeaks ? [] : read.events.map(guardrailTurnEvent);
  const events = [...prior, ...detected, ...(judged ? [judged] : [])];

  if (verdict.action === 'redact') {
    return { action: 'emit', events: [...events, { type: 'text', text: verdict.text }] };
  }
  if (verdict.action === 'block') {
    if (egress?.onBlock === 'refuse_to_user') {
      const text = lexiconText('egress.refusal', {}, session.context.lexicon);
      return { action: 'emit', events: [...events, { type: 'text', text }] };
    }
    return {
      action: 'withhold',
      error: new TheoremError('safety', WITHHELD_REASON.egress),
      events,
    };
  }
  if (read.rewritten) {
    // why: The audio says what the transcript did: only the replaced text goes out.
    return { action: 'emit', events: [...events, { type: 'text', text: read.payload.text }] };
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
  if (cycleIsJudged(session)) {
    return await finalEgressVerdict(session, gate, events);
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
