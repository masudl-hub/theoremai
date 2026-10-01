import { type DecisionProfile, defineProfile, TheoremError, type TurnEvent } from '../mod.ts';
import {
  type DecisionTransport,
  decisionInterface,
} from '../react/src/client/decision-transport.ts';
import { type HostTransport, hostInterface } from '../react/src/client/host-transport.ts';
import { createTraceFeed } from '../react/src/client/trace-feed.ts';
import {
  hostError,
  type TheoremTransport,
  type TurnEventSink,
} from '../react/src/client/transport.ts';
import { createMemorySteerInbox, steerUnitOf } from '../react/src/server/steer-inbox.ts';
import { toErrorEvent, withPublicWording } from '../src/guardrails/error.ts';
import type { RunDecisionOptions } from '../src/kernel/engine/decision.ts';
import type { PlaygroundRunPayload } from './run-payload.ts';
import {
  runPlaygroundDecision,
  streamPlaygroundCall,
  streamPlaygroundInvoke,
  streamPlaygroundTurn,
} from './runtime.ts';
import type { PlaygroundRuntime } from './runtime-scope.ts';
import type { PlaygroundTraceLine } from './traces.ts';
import {
  type PlaygroundSteerLine,
  playgroundInterface,
  routePlaygroundLines,
} from './transport.ts';

export interface PlaygroundBrowserRuntime extends PlaygroundRuntime {
  mode: 'byok' | 'local';
  decision?: Pick<RunDecisionOptions, 'vault' | 'fetch'>;
  /** Disconnecting aborts active requests, without retaining the vault in a saved payload. */
  signal?: AbortSignal;
}

function runSignal(
  runtime: PlaygroundBrowserRuntime,
  signal?: AbortSignal,
): AbortSignal | undefined {
  return runtime.signal && signal
    ? AbortSignal.any([runtime.signal, signal])
    : (runtime.signal ?? signal);
}

/** Direct streams use the same event and trace routing as the HTTP transport. */
async function deliver(
  source: AsyncIterable<TurnEvent | PlaygroundTraceLine | PlaygroundSteerLine>,
  payload: PlaygroundRunPayload,
  sink: ReturnType<typeof routePlaygroundLines>,
): Promise<void> {
  try {
    for await (const line of source) {
      if (line.type === 'error') throw hostError(line, 'internal');
      sink(line);
    }
  } catch (error) {
    const event = withPublicWording(toErrorEvent(error), payload.profile.lexicon);
    if (event.type === 'error') throw hostError(event, 'internal');
    throw error;
  }
}

export function createBrowserPlaygroundTransport(
  payload: PlaygroundRunPayload,
  runtime: PlaygroundBrowserRuntime,
): TheoremTransport {
  const traces = createTraceFeed();
  const steer = createMemorySteerInbox();
  const inboxes = new Map<string, string>();
  const compiled = {
    profile: payload.profile,
    customTools: payload.customTools,
    structured: payload.structured,
    runtime,
  };
  const route = (onEvent: TurnEventSink, onInbox = (_inbox: string) => {}) =>
    routePlaygroundLines(onEvent, traces, onInbox);
  return {
    describe: () => Promise.resolve(playgroundInterface(payload)),
    async turn(request, onEvent, signal) {
      try {
        const source = streamPlaygroundTurn({
          ...compiled,
          ...request,
          signal: runSignal(runtime, signal),
          steer,
          abandon: request.abandon?.map((callId) => {
            const replay = request.replay?.abandon?.[callId];
            if (!replay) {
              throw new TheoremError('request', 'No replay for abandoned call'); // lexicon-exempt: internal diagnostic
            }
            return { callId, replay };
          }),
        });
        await deliver(
          source,
          payload,
          route(onEvent, (inbox) => {
            if (request.turnId) inboxes.set(request.turnId, inbox);
          }),
        );
      } finally {
        if (request.turnId) inboxes.delete(request.turnId);
      }
    },
    invoke: (answer, onEvent, signal) =>
      deliver(
        streamPlaygroundInvoke({
          ...compiled,
          answer,
          signal: runSignal(runtime, signal),
        }),
        payload,
        route(onEvent),
      ),
    async steer(request) {
      const inbox = inboxes.get(request.turnId);
      if (!inbox || !(await steer.enqueue(inbox, steerUnitOf(request)))) {
        throw new TheoremError('request', 'The turn has ended', {
          copy: { key: 'session.turn_ended' },
        }); // lexicon-exempt: internal diagnostic
      }
    },
    traces,
  };
}

export function createBrowserPlaygroundHostTransport(
  payload: PlaygroundRunPayload,
  runtime: PlaygroundBrowserRuntime,
): HostTransport {
  const traces = createTraceFeed();
  let sessionPermissions: string[] = [];
  const compiled = {
    profile: payload.profile,
    customTools: payload.customTools,
    runtime,
  };
  const route = (onEvent: TurnEventSink) => routePlaygroundLines(onEvent, traces, () => {});
  return {
    describe: () =>
      Promise.resolve(
        hostInterface(
          defineProfile(payload.profile) as Extract<
            ReturnType<typeof defineProfile>,
            { type: 'host' }
          >,
          (name) => payload.customTools.find((tool) => tool.name === name),
        ),
      ),
    call: (call, onEvent, signal) =>
      deliver(
        streamPlaygroundCall({
          ...compiled,
          call,
          sessionPermissions,
          signal: runSignal(runtime, signal),
        }),
        payload,
        route(onEvent),
      ),
    invoke(answer, onEvent, signal) {
      sessionPermissions = answer.replay?.sessionPermissions ?? sessionPermissions;
      return deliver(
        streamPlaygroundInvoke({
          ...compiled,
          answer,
          signal: runSignal(runtime, signal),
        }),
        payload,
        route(onEvent),
      );
    },
    traces,
  };
}

export function createBrowserPlaygroundDecisionTransport(
  payload: PlaygroundRunPayload,
  runtime: PlaygroundBrowserRuntime,
): DecisionTransport {
  const traces = createTraceFeed();
  return {
    describe: () =>
      Promise.resolve(
        decisionInterface(
          defineProfile(payload.profile) as DecisionProfile,
          payload.questions ?? {},
        ),
      ),
    decide: (state, signal) =>
      runPlaygroundDecision(payload, state, runtime.decision ?? {}, runSignal(runtime, signal)),
    traces,
  };
}
