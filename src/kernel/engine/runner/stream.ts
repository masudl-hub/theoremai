import type { Boundary } from '../../../guardrails/boundaries.ts';
import { isStreamedCanaryEvent, type StreamedReplyEvent } from '../../../guardrails/canary.ts';
import { type Detection, detectEvent, leakScopeOf } from '../../../guardrails/detect-at.ts';
import {
  eventLeak,
  isPromptLeakHit,
  promptLeakReason,
  WITHHELD_REASON,
} from '../../../guardrails/egress.ts';
import type { GivenUrls } from '../../../guardrails/egress-urls.ts';
import { TheoremError, throwIfAborted, toErrorEvent } from '../../../guardrails/error.ts';
import { guardrailFromHits, guardrailTurnEvent } from '../../../guardrails/events.ts';
import { resolveGuardrailPolicy } from '../../../guardrails/policy.ts';
import {
  createOutboundProgressiveGate,
  type ProgressiveYieldGate,
  type ProgressiveYieldResult,
} from '../../../guardrails/progressive-yield.ts';
import { EGRESS_RULES } from '../../../guardrails/rules.ts';
import {
  type ThoughtGuard,
  type ThoughtRelease,
  thoughtGuardFor,
} from '../../../guardrails/thought-guard.ts';
import type { OwnTools } from '../../../guardrails/tool-leak.ts';
import type {
  GuardrailContext,
  GuardrailHit,
  ResolvedGuardrailPolicy,
} from '../../../guardrails/types.ts';
import { profileTurnOutputs } from '../../registry/profile-outputs.ts';
import type {
  ModelProvider,
  Profile,
  ProviderCompleteRequest,
  ProviderEvent,
  ResolvedGeneration,
} from '../../types.ts';
import type { CallTrace, StreamCheck } from '../turn-trace.ts';

/** What the stream yields to the step runner: every provider event but `response`, which only the trace reads. */
export type StreamEvent = Exclude<ProviderEvent, { type: 'response' }>;

interface OutboundStreamControl {
  /** Stop releasing text/media to the host; keep recording for egress. */
  withholdVisible: boolean;
  /**
   * The canary opening the turn's earlier steps ended on (`canaryCarry`): read
   * in front of this call's reply, and replaced by where this call ends.
   */
  canaryCarry?: string;
  /** System-prompt leak hits this call withheld under a host policy; they pin its verdict. */
  promptLeaks?: GuardrailHit[];
  /** What the turn's thoughts so far ended on (`ThoughtGuard.carryOut`): read in front of this call's, and replaced. */
  thoughtCarry?: string;
}

function shouldSkipStreamEvent(event: ProviderEvent, profile: Profile): boolean {
  return (
    event.type === 'thought' && profileTurnOutputs(profile)?.streaming?.streamThoughts === false
  );
}

/**
 * A leak in an event that is not the reply's text ends the turn there: the
 * event never reaches the host, and it has no text to replace.
 */
function* yieldLeakStop(hits: GuardrailHit[]): Generator<StreamEvent> {
  if (hits.some((hit) => hit.rule === EGRESS_RULES.providerToolLeak)) {
    yield* yieldDeltaBlock(hits);
  } else {
    yield* yieldDetected('reply', { action: 'block', hits });
  }
  const reason = promptLeakReason(hits);
  yield toErrorEvent(new TheoremError('safety', reason));
  // why: The turn ends because our guardrail blocked the output, not because the model finished.
  const native =
    reason === WITHHELD_REASON.canary
      ? 'canary'
      : reason === WITHHELD_REASON.promptEcho
        ? 'prompt_echo'
        : 'provider_tool_leak';
  yield { type: 'done', stop: { kind: 'filtered', native } };
}

function* yieldDeltaBlock(hits: GuardrailHit[]): Generator<StreamEvent> {
  const guardrail = guardrailFromHits('output_delta', 'untrusted', hits, 'block');
  if (guardrail) {
    yield guardrail;
  }
}

/** What `guardrails.detect` found at `boundary` in text released as it streamed. */
function* yieldDetected(
  boundary: Boundary,
  found: Pick<Detection, 'action' | 'hits'> | undefined,
): Generator<StreamEvent> {
  const event = found && detectEvent(boundary, found, undefined, STREAMED_STAGE[boundary]);
  if (event) yield guardrailTurnEvent(event);
}

/** The stage a boundary reports under while its text streams, where that is not its own. */
const STREAMED_STAGE: Partial<Record<Boundary, 'output_delta'>> = { reply: 'output_delta' };

/** What the guard released, after the events saying what was found in it and omitted from it. */
function* yieldThought(
  { text, hits, found }: ThoughtRelease,
  event: StreamEvent & { type: 'thought' },
): Generator<StreamEvent> {
  yield* yieldDetected('thought', found);
  const guardrail = guardrailFromHits('thought', 'untrusted', hits, 'redact');
  if (guardrail) yield guardrail;
  if (text) yield { ...event, text };
}

/** The thought held at the end of a call, and what the next call's thoughts read on from. */
function* flushThoughts(
  thoughts: ThoughtGuard | undefined,
  control: OutboundStreamControl | undefined,
): Generator<StreamEvent> {
  if (!thoughts) return;
  yield* yieldThought(thoughts.flush(), { type: 'thought', text: '' });
  if (control) control.thoughtCarry = thoughts.carryOut();
}

/** Host-visible output a mid-stream block withholds. A thought is never withheld, only omitted from. */
function isWithheldOnBlock(event: ProviderEvent): boolean {
  return event.type === 'text' || event.type === 'media';
}

/**
 * Events read at a boundary of their own, not with the reply's text: the
 * model's tool call at its `tool_arguments` boundary, and the structured
 * output at `reply_structured`.
 */
function isReadElsewhere(event: StreamEvent): boolean {
  return event.type === 'structured' || event.type === 'tool';
}

interface StreamArgs {
  profile: Profile;
  generation: ResolvedGeneration;
  request: ProviderCompleteRequest;
  /** The private stretches of `request.system` (`BoundSystem.private`). */
  privateSystem: readonly string[];
  provider: ModelProvider;
  /** This call's recorder: sees every tap row and every provider event before any gate. */
  call: Pick<CallTrace, 'tap' | 'observe'> & Partial<Pick<CallTrace, 'guardTime' | 'guardrail'>>;
  signal?: AbortSignal;
  control?: OutboundStreamControl;
  /** Every URL the model has been given this turn. */
  givenUrls: GivenUrls;
  /** Whether the model has been given the canary this turn. */
  canaryGiven?: boolean;
  /** The names of the profile's tools and of their parameters. */
  ownTools?: OwnTools;
}

/** What the stream's checks know of the turn. */
function streamContext(
  args: Pick<
    StreamArgs,
    'profile' | 'generation' | 'privateSystem' | 'givenUrls' | 'canaryGiven' | 'ownTools'
  >,
  policy: ResolvedGuardrailPolicy,
): GuardrailContext {
  const { profile, privateSystem, canaryGiven } = args;
  const { canary } = args.generation;
  return {
    stage: 'output_final',
    trust: 'untrusted',
    profileId: profile.id,
    ...(profile.lexicon ? { lexicon: profile.lexicon } : {}),
    ...leakScopeOf(policy.detect, { canary, canaryGiven, privateSystem }),
    givenUrls: args.givenUrls,
    ...(args.ownTools ? { ownTools: args.ownTools } : {}),
  };
}

async function* yieldProviderEvents(args: StreamArgs): AsyncGenerator<StreamEvent> {
  const { profile, request, provider, call, signal, control } = args;
  /** Runs one stream check and adds the run to the call's record of that check. */
  async function timed<T>(check: StreamCheck, run: () => T | Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await run();
    } finally {
      call.guardTime?.(check, performance.now() - start);
    }
  }
  const policy = resolveGuardrailPolicy(profile.guardrails);
  const context = streamContext(args, policy);
  const { canaryCarry, thoughtCarry } = control ?? {};
  const gate: ProgressiveYieldGate | null = createOutboundProgressiveGate(
    policy,
    context,
    'reply',
    canaryCarry,
  );
  const thoughts = thoughtGuardFor(policy, context, thoughtCarry);
  /** The streamed event whose reply sits in the gate's lookback; released tails keep its shape. */
  let pendingStream: StreamedReplyEvent | null = null;
  let withholdVisible = false;

  /**
   * A leak the gate stopped on goes to the end-of-attempt verdict, which reads
   * the whole reply for it: one that reading misses still blocks.
   */
  function recordPromptLeak(hits: GuardrailHit[]): void {
    const leaks = hits.filter(isPromptLeakHit);
    if (control && leaks.length > 0) control.promptLeaks = leaks;
  }

  function armWithhold(): void {
    withholdVisible = true;
    if (control) control.withholdVisible = true;
  }

  function withholding(): boolean {
    return withholdVisible;
  }

  async function* drainBlockedDelta(
    hits: GuardrailHit[],
    template: StreamedReplyEvent,
  ): AsyncGenerator<StreamEvent, void> {
    yield* yieldDeltaBlock(hits);
    // why: Arm withhold before recording the unreleased tail so the step runner
    // does not forward that text to the host.
    armWithhold();
    const tail = gate?.drainUnreleased();
    if (tail) yield { ...template, text: tail };
  }

  async function* flushGate(): AsyncGenerator<StreamEvent, 'stop' | 'pass'> {
    if (!(gate && pendingStream)) {
      return 'pass';
    }
    const template = pendingStream;
    const result = await timed('output_stream', () => gate.flush());
    pendingStream = null;
    return (yield* releaseOrBlock(result, template)) === 'stop' ? 'stop' : 'pass';
  }

  /**
   * Act on one gate step: release what it cleared, or withhold the rest of the
   * reply for the verdict on the whole of it.
   */
  async function* releaseOrBlock(
    result: ProgressiveYieldResult,
    template: StreamedReplyEvent,
  ): AsyncGenerator<StreamEvent, 'stop' | 'go'> {
    if (result.blocked) {
      recordPromptLeak(result.hits);
      // why: A detector's stop is reported once, by the verdict on the whole reply. The trace
      // still records that this check is the one that stopped it.
      const stopped =
        result.boundary &&
        detectEvent(
          result.boundary,
          { action: 'block', hits: result.hits },
          undefined,
          'output_delta',
        );
      if (stopped) call.guardrail?.(stopped);
      yield* drainBlockedDelta(result.boundary ? [] : result.hits, template);
      return 'go';
    }
    yield* yieldDetected('reply', result.found);
    if (result.emit) {
      yield { ...template, text: result.emit };
    }
    return 'go';
  }

  async function* gateStreamEvent(
    event: StreamedReplyEvent,
  ): AsyncGenerator<StreamEvent, 'continue' | 'stop'> {
    if (!gate) {
      yield event;
      return 'continue';
    }
    if (withholding()) {
      // why: Keep recording ungated fragments for egress context; host will not see them.
      yield { ...event, text: event.text ?? '' };
      return 'continue';
    }
    pendingStream = event;
    const result = await timed('output_stream', () => gate.process(event.text ?? ''));
    return (yield* releaseOrBlock(result, event)) === 'stop' ? 'stop' : 'continue';
  }

  /** Whether a thought has streamed since the guard last flushed. */
  let thinking = false;

  /** A thought, through the guard when there is one; false for any other event. */
  function* guardThought(event: StreamEvent): Generator<StreamEvent, boolean> {
    if (event.type !== 'thought' || !thoughts) return false;
    thinking = true;
    yield* yieldThought(thoughts.push(event.text), event);
    return true;
  }

  /** The reply ends the thought: release its hold, as a call's end does, reading on from the carry. */
  function* endThought(): Generator<StreamEvent> {
    if (!thinking) return;
    thinking = false;
    yield* flushThoughts(thoughts, control);
  }

  throwIfAborted(signal);
  let providerFailed = false;
  for await (const event of provider.complete({ ...request, signal, tapUpstream: call.tap })) {
    call.observe(event);
    throwIfAborted(signal);
    if (event.type === 'response') {
      // why: Identity is the trace's alone; the call span already recorded it.
      continue;
    }

    if (yield* guardThought(event)) continue;

    if (isStreamedCanaryEvent(event)) {
      yield* endThought();
      const status = yield* gateStreamEvent(event);
      if (status === 'stop') {
        return;
      }
      continue;
    }

    // why: Release held reply text first so the host sees events in order.
    const flushed = yield* flushGate();
    if (flushed === 'stop') {
      return;
    }

    const leak = isReadElsewhere(event)
      ? undefined
      : await timed('stream_canary', () => eventLeak(event, context, policy.detect, 'reply'));
    if (leak?.stop) {
      yield* yieldLeakStop(leak.hits);
      return;
    }
    if (leak) yield* yieldDetected('reply', { action: 'flag', hits: leak.hits });

    if (withholding() && isWithheldOnBlock(event)) {
      // why: Record for attempt egress / repair; step runner withholds from host.
      yield event;
      continue;
    }

    if (event.type === 'error') {
      providerFailed = true;
    }
    if (event.type === 'done') yield* flushThoughts(thoughts, control);
    yield event;
  }

  yield* flushThoughts(thoughts, control);

  const flushed = yield* flushGate();
  if (flushed === 'stop') {
    return;
  }
  if (control && gate) {
    control.canaryCarry = gate.carryOut();
  }
  if (providerFailed) {
    // why: An error from the provider outranks any `done` it sent: the call's output is not whole.
    yield { type: 'done', stop: { kind: 'provider_error' } };
  }
}

export type { OutboundStreamControl, StreamArgs };
export { isWithheldOnBlock, shouldSkipStreamEvent, yieldProviderEvents };
