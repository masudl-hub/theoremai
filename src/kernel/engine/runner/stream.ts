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
import { providerCompleteRequest } from '../../registry/provider-request.ts';
import type { ModelProvider, Profile, ResolvedGeneration, TurnEvent } from '../../types.ts';

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

function hasCanaryHit(hits: GuardrailHit[]): boolean {
  return hits.some((hit) => hit.rule === EGRESS_RULES.canary);
}

async function* yieldProviderEvents(args: {
  profile: Profile;
  generation: ResolvedGeneration;
  system: string;
  provider: ModelProvider;
  upstream: Record<string, unknown>[];
  signal?: AbortSignal;
  control?: OutboundStreamControl;
}): AsyncGenerator<TurnEvent> {
  const { profile, generation, system, provider, upstream, signal, control } = args;
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

  async function* flushGate(): AsyncGenerator<TurnEvent, 'stop' | 'pass'> {
    if (!gate || !lastStreamType) {
      return 'pass';
    }
    const emitType = lastStreamType;
    const result = await gate.flush();
    lastStreamType = undefined;
    if (result.blocked) {
      if (hasCanaryHit(result.hits) && canary && canaryOnlyImmediateStop(policy)) {
        yield* yieldCanaryLeak(canary, { type: emitType, text: gate.accumulated() });
        return 'stop';
      }
      yield* yieldDeltaBlock(result.hits);
      // Arm withhold before recording the unreleased tail so the step runner
      // does not forward that text to the host.
      armWithhold();
      const tail = gate.drainUnreleased();
      if (tail) yield { type: 'text', text: tail };
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
      if (hasCanaryHit(result.hits) && canary && canaryOnlyImmediateStop(policy)) {
        yield* yieldCanaryLeak(canary, event);
        return 'stop';
      }
      yield* yieldDeltaBlock(result.hits);
      armWithhold();
      const tail = gate.drainUnreleased();
      if (tail) yield { type: 'text', text: tail };
      return 'continue';
    }
    if (result.emit) {
      yield* processNormalEvent({ ...event, text: result.emit });
    }
    return 'continue';
  }

  throwIfAborted(signal);
  for await (const event of provider.complete({
    ...providerCompleteRequest(generation, system),
    signal,
    tapUpstream: (row) => {
      upstream.push(row);
    },
  })) {
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

    yield* processNormalEvent(event);
  }

  if (gate && lastStreamType) {
    const flushed = yield* flushGate();
    if (flushed === 'stop') {
      return;
    }
  }
}

export type { OutboundStreamControl };
export { shouldSkipStreamEvent, yieldProviderEvents };
