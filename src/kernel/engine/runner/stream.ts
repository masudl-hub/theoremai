import { eventHasCanary, isStreamedCanaryEvent } from '../../../guardrails/canary.ts';
import { CANARY_HIT } from '../../../guardrails/egress.ts';
import { publicError, throwIfAborted, toErrorEvent } from '../../../guardrails/error.ts';
import { guardrailFromHits } from '../../../guardrails/events.ts';
import { resolveGuardrailPolicy } from '../../../guardrails/policy.ts';
import {
  createOutboundProgressiveGate,
  type ProgressiveYieldGate,
} from '../../../guardrails/progressive-yield.ts';
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
  ResolvedGeneration,
  TurnEvent,
} from '../../types.ts';
import type { CallTrace } from '../turn-trace.ts';

/** Mutable control flags shared with the step runner during one provider stream. */
interface OutboundStreamControl {
  /** Stop releasing text/media to the host; keep recording for egress. Thoughts are unguarded. */
  withholdVisible: boolean;
}

function shouldSkipStreamEvent(event: TurnEvent, profile: Profile): boolean {
  return (
    event.type === 'thought' && profileTurnOutputs(profile)?.streaming?.streamThoughts === false
  );
}

function* processNormalEvent(event: TurnEvent): Generator<TurnEvent> {
  if (event.type === 'error') {
    const internal = event.errorInternal ?? event.error ?? '';
    yield {
      type: 'error',
      error: publicError(event.error ?? internal),
      ...(internal ? { errorInternal: internal } : {}),
    };
  } else {
    yield event;
  }
}

/** The offending text never reaches the host: redaction cannot cover a partial or encoded token. */
function* yieldCanaryLeak(): Generator<TurnEvent> {
  yield* yieldDeltaBlock([CANARY_HIT]);
  yield toErrorEvent('canary leaked');
  // The turn ends because our guardrail blocked the output, not because the model finished.
  yield { type: 'done', stop: { kind: 'filtered', native: 'canary' } };
}

function* yieldDeltaBlock(hits: GuardrailHit[]): Generator<TurnEvent> {
  const guardrail = guardrailFromHits('output_delta', 'untrusted', hits, 'block');
  if (guardrail) {
    yield guardrail;
  }
}

/** Host-visible output a mid-stream block withholds. Thoughts are not guarded (`isGuardedOutput`). */
function isWithheldOnBlock(event: TurnEvent): boolean {
  return event.type === 'text' || event.type === 'media';
}

function canaryOnlyImmediateStop(policy: ResolvedGuardrailPolicy): boolean {
  return !policy.egress?.enforce;
}

async function* yieldProviderEvents(args: {
  profile: Profile;
  generation: ResolvedGeneration;
  /** What the adapter is asked to send (`providerCompleteRequest`). */
  request: ProviderCompleteRequest;
  provider: ModelProvider;
  /** This call's recorder: sees every tap row and every provider event before any gate. */
  call: Pick<CallTrace, 'tap' | 'observe'>;
  signal?: AbortSignal;
  control?: OutboundStreamControl;
}): AsyncGenerator<TurnEvent> {
  const { profile, generation, request, provider, call, signal, control } = args;
  const { canary } = generation;
  const policy = resolveGuardrailPolicy(profile.guardrails);
  const context: GuardrailContext = {
    stage: 'output_final',
    trust: 'untrusted',
    profileId: profile.id,
    ...(canary ? { canary } : {}),
  };
  const gate: ProgressiveYieldGate | null = createOutboundProgressiveGate(policy, context);
  /** The streamed event whose reply sits in the gate's lookback; released tails keep its shape. */
  let pendingStream: TurnEvent | null = null;
  let withholdVisible = false;

  function armWithhold(): void {
    withholdVisible = true;
    if (control) control.withholdVisible = true;
  }

  function withholding(): boolean {
    return withholdVisible;
  }

  async function* drainBlockedDelta(
    hits: GuardrailHit[],
    template: TurnEvent,
  ): AsyncGenerator<TurnEvent, void> {
    yield* yieldDeltaBlock(hits);
    // Arm withhold before recording the unreleased tail so the step runner
    // does not forward that text to the host.
    armWithhold();
    const tail = gate?.drainUnreleased();
    if (tail) yield { ...template, text: tail };
  }

  async function* flushGate(): AsyncGenerator<TurnEvent, 'stop' | 'pass'> {
    if (!(gate && pendingStream)) {
      return 'pass';
    }
    const template = pendingStream;
    const result = await gate.flush();
    pendingStream = null;
    if (result.blocked) {
      if (canary && canaryOnlyImmediateStop(policy)) {
        yield* yieldCanaryLeak();
        return 'stop';
      }
      yield* drainBlockedDelta(result.hits, template);
      return 'pass';
    }
    if (result.emit) {
      yield* processNormalEvent({ ...template, text: result.emit });
    }
    return 'pass';
  }

  async function* gateStreamEvent(
    event: TurnEvent,
  ): AsyncGenerator<TurnEvent, 'continue' | 'stop'> {
    if (!gate) {
      yield* processNormalEvent(event);
      return 'continue';
    }
    if (withholding()) {
      // Keep recording ungated fragments for egress context; host will not see them.
      yield { ...event, text: event.text ?? '' };
      return 'continue';
    }
    pendingStream = event;
    const result = await gate.process(event.text ?? '');
    if (result.blocked) {
      if (canary && canaryOnlyImmediateStop(policy)) {
        yield* yieldCanaryLeak();
        return 'stop';
      }
      yield* drainBlockedDelta(result.hits, event);
      return 'continue';
    }
    if (result.emit) {
      yield* processNormalEvent({ ...event, text: result.emit });
    }
    return 'continue';
  }

  throwIfAborted(signal);
  let providerFailed = false;
  for await (const event of provider.complete({ ...request, signal, tapUpstream: call.tap })) {
    call.observe(event);
    throwIfAborted(signal);
    if (event.type === 'response') {
      // Identity is the trace's alone; the call span already recorded it.
      continue;
    }

    if (isStreamedCanaryEvent(event)) {
      const status = yield* gateStreamEvent(event);
      if (status === 'stop') {
        return;
      }
      continue;
    }

    // Release held reply text first so the host sees events in order.
    const flushed = yield* flushGate();
    if (flushed === 'stop') {
      return;
    }

    if (canary && eventHasCanary(event, canary)) {
      yield* yieldCanaryLeak();
      return;
    }

    if (withholding() && isWithheldOnBlock(event)) {
      // Record for attempt egress / repair; step runner withholds from host.
      yield event;
      continue;
    }

    if (event.type === 'error') {
      providerFailed = true;
    }
    yield* processNormalEvent(event);
  }

  const flushed = yield* flushGate();
  if (flushed === 'stop') {
    return;
  }
  if (providerFailed) {
    // An error from the provider outranks any `done` it sent: the call's output is not whole.
    yield { type: 'done', stop: { kind: 'provider_error' } };
  }
}

export type { OutboundStreamControl };
export { isWithheldOnBlock, shouldSkipStreamEvent, yieldProviderEvents };
