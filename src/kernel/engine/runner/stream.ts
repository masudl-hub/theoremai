import { eventHasCanary, isStreamedCanaryEvent, redactCanary } from '../../../guardrails/canary.ts';
import { EGRESS_RULES } from '../../../guardrails/egress.ts';
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
  /** Stop releasing text/thought/media to the host; keep recording for egress. */
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

function* yieldCanaryLeak(canary: string, event: TurnEvent): Generator<TurnEvent> {
  const guardrail = guardrailFromHits(
    'output_delta',
    'untrusted',
    [{ rule: EGRESS_RULES.canary, severity: 'high', match: '[canary]' }],
    'block',
  );
  if (guardrail) {
    yield guardrail;
  }
  yield redactCanary(event, canary);
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

function isHostVisible(event: TurnEvent): boolean {
  return event.type === 'text' || event.type === 'thought' || event.type === 'media';
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
  let lastStreamType: 'text' | 'thought' | undefined;
  let withholdVisible = false;

  function armWithhold(): void {
    withholdVisible = true;
    if (control) control.withholdVisible = true;
  }

  function withholding(): boolean {
    return withholdVisible;
  }

  async function* drainBlockedDelta(hits: GuardrailHit[]): AsyncGenerator<TurnEvent, void> {
    yield* yieldDeltaBlock(hits);
    // Arm withhold before recording the unreleased tail so the step runner
    // does not forward that text to the host.
    armWithhold();
    const tail = gate?.drainUnreleased();
    if (tail) yield { type: 'text', text: tail };
  }

  async function* flushGate(): AsyncGenerator<TurnEvent, 'stop' | 'pass'> {
    if (!gate || !lastStreamType) {
      return 'pass';
    }
    const emitType = lastStreamType;
    const result = await gate.flush();
    lastStreamType = undefined;
    if (result.blocked) {
      if (canary && canaryOnlyImmediateStop(policy)) {
        yield* yieldCanaryLeak(canary, {
          type: emitType,
          text: gate.accumulated(),
        });
        return 'stop';
      }
      yield* drainBlockedDelta(result.hits);
      return 'pass';
    }
    if (result.emit) {
      yield* processNormalEvent({ type: emitType, text: result.emit });
    }
    return 'pass';
  }

  async function* gateStreamEvent(
    event: TurnEvent & { type: 'text' | 'thought' },
  ): AsyncGenerator<TurnEvent, 'continue' | 'stop'> {
    if (!gate) {
      yield* processNormalEvent(event);
      return 'continue';
    }
    if (withholding()) {
      // Keep recording ungated fragments for egress context; host will not see them.
      yield { type: event.type, text: event.text ?? '' };
      return 'continue';
    }
    if (lastStreamType && lastStreamType !== event.type) {
      const flushed = yield* flushGate();
      if (flushed === 'stop') {
        return 'stop';
      }
    }
    lastStreamType = event.type;
    const result = await gate.process(event.text ?? '');
    if (result.blocked) {
      if (canary && canaryOnlyImmediateStop(policy)) {
        yield* yieldCanaryLeak(canary, event);
        return 'stop';
      }
      yield* drainBlockedDelta(result.hits);
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

    if (isStreamedCanaryEvent(event)) {
      const status = yield* gateStreamEvent(event);
      if (status === 'stop') {
        return;
      }
      continue;
    }

    if (gate && lastStreamType) {
      const flushed = yield* flushGate();
      if (flushed === 'stop') {
        return;
      }
    }

    if (canary && eventHasCanary(event, canary)) {
      yield* yieldCanaryLeak(canary, event);
      return;
    }

    if (withholding() && isHostVisible(event)) {
      // Record for attempt egress / repair; step runner withholds from host.
      yield event;
      continue;
    }

    if (event.type === 'error') {
      providerFailed = true;
    }
    yield* processNormalEvent(event);
  }

  if (gate && lastStreamType) {
    const flushed = yield* flushGate();
    if (flushed === 'stop') {
      return;
    }
  }
  if (providerFailed) {
    // An error from the provider outranks any `done` it sent: the call's output is not whole.
    yield { type: 'done', stop: { kind: 'provider_error' } };
  }
}

export type { OutboundStreamControl };
export { shouldSkipStreamEvent, yieldProviderEvents };
