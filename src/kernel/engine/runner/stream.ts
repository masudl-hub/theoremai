import {
  type CanaryStreamGate,
  createCanaryStreamGate,
  eventHasCanary,
  isStreamedCanaryEvent,
  redactCanary,
} from '../../../guardrails/canary.ts';
import { publicError, throwIfAborted, toErrorEvent } from '../../../guardrails/error.ts';
import { profileTurnOutputs } from '../../registry/profile-outputs.ts';
import { providerCompleteRequest } from '../../registry/provider-request.ts';
import type { ModelProvider, Profile, ResolvedGeneration, TurnEvent } from '../../types.ts';

function systemFromProfile(profile: Profile, role: string): string {
  const { identity } = profile;
  const { systemByRole, system } = identity;
  if (systemByRole) {
    const byRole = systemByRole[role];
    if (byRole) {
      return byRole;
    }
  }
  if (system) {
    return system;
  }
  return '';
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
  yield redactCanary(event, canary);
  yield toErrorEvent('canary leaked');
}

function* yieldGatedStreamEvent(
  event: TurnEvent & { type: 'text' | 'thought' },
  gate: CanaryStreamGate,
  canary: string,
): Generator<TurnEvent, 'continue' | 'stop'> {
  const fragment = event.text ?? '';
  const result = gate.process(fragment);
  if (result.leak) {
    yield* yieldCanaryLeak(canary, event);
    return 'stop';
  }
  if (result.emit) {
    yield* processNormalEvent({ ...event, text: result.emit });
  }
  return 'continue';
}

function* flushCanaryGate(
  gate: CanaryStreamGate,
  _canary: string,
  lastType: 'text' | 'thought' | undefined,
): Generator<TurnEvent, 'stop' | 'pass'> {
  const result = gate.flush();
  if (result.leak) {
    yield toErrorEvent('canary leaked');
    return 'stop';
  }
  if (result.emit) {
    const emitType = lastType ?? 'text';
    yield* processNormalEvent({ type: emitType, text: result.emit });
  }
  return 'pass';
}

async function* yieldProviderEvents(args: {
  generation: ResolvedGeneration;
  system: string;
  provider: ModelProvider;
  upstream: Record<string, unknown>[];
  signal?: AbortSignal;
}): AsyncGenerator<TurnEvent> {
  const { generation, system, provider, upstream, signal } = args;
  const { canary } = generation;
  const gate = canary ? createCanaryStreamGate(canary) : null;
  let lastStreamType: 'text' | 'thought' | undefined;

  throwIfAborted(signal);
  for await (const event of provider.complete({
    ...providerCompleteRequest(generation, system),
    signal,
    tapUpstream: (row) => {
      upstream.push(row);
    },
  })) {
    throwIfAborted(signal);

    if (gate && isStreamedCanaryEvent(event)) {
      if (lastStreamType && lastStreamType !== event.type) {
        const status = yield* flushCanaryGate(gate, canary, lastStreamType);
        if (status === 'stop') {
          return;
        }
      }
      lastStreamType = event.type;
      const status = yield* yieldGatedStreamEvent(event, gate, canary);
      if (status === 'stop') {
        return;
      }
      continue;
    }

    if (gate && lastStreamType) {
      const status = yield* flushCanaryGate(gate, canary, lastStreamType);
      if (status === 'stop') {
        return;
      }
      lastStreamType = undefined;
    }

    if (canary && eventHasCanary(event, canary)) {
      yield* yieldCanaryLeak(canary, event);
      return;
    }

    yield* processNormalEvent(event);
  }

  if (gate) {
    const status = yield* flushCanaryGate(gate, canary, lastStreamType);
    if (status === 'stop') {
      return;
    }
  }
}

export { shouldSkipStreamEvent, systemFromProfile, yieldProviderEvents };
