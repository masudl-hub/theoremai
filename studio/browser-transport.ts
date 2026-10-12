import { browserExecution } from './browser-execution.ts';
import { type DecisionProfile, defineProfile, TheoremError, type TurnEvent } from '../mod.ts';
import {
  type DecisionTransport,
  decisionInterface,
} from '../react/src/client/decision-transport.ts';
import { type HostTransport, hostInterface } from '../react/src/client/host-transport.ts';
import { createTraceFeed, type TraceFeed } from '../react/src/client/trace-feed.ts';
import {
  hostError,
  type HostErrorBody,
  type TheoremTransport,
  type TurnEventSink,
} from '../react/src/client/transport.ts';
import { createMemorySteerInbox, steerUnitOf } from '../react/src/server/steer-inbox.ts';
import { toErrorEvent, withPublicWording } from '../src/guardrails/error.ts';
import type { RunDecisionOptions } from '../src/kernel/engine/decision.ts';
import type { StudioRunPayload } from './run-payload.ts';
import {
  runStudioDecision,
  streamStudioCall,
  streamStudioInvoke,
  streamStudioTurn,
} from './runtime.ts';
import type { StudioRuntime } from './runtime-scope.ts';
import type { StudioTraceLine } from './traces.ts';
import {
  type StudioSteerLine,
  studioInterface,
  routeStudioLines,
} from './transport.ts';

export interface StudioBrowserRuntime extends StudioRuntime {
  mode: 'byok' | 'local';
  decision?: Pick<RunDecisionOptions, 'vault' | 'fetch'>;
  /** Disconnecting aborts active requests, without retaining the vault in a saved payload. */
  signal?: AbortSignal;
}

function runSignal(
  runtime: StudioBrowserRuntime,
  signal?: AbortSignal,
): AbortSignal | undefined {
  return runtime.signal && signal
    ? AbortSignal.any([runtime.signal, signal])
    : (runtime.signal ?? signal);
}

/**
 * The builder runs this turn on their own keys and machine, so the failure says what actually
 * happened (a rejected key, an unreachable server) rather than the visitor wording.
 */
function builderError(event: HostErrorBody): Error {
  return hostError({ ...event, error: event.errorInternal ?? event.error }, 'internal');
}

/** Direct streams use the same event and trace routing as the HTTP transport. */
async function deliver(
  source: AsyncIterable<TurnEvent | StudioTraceLine | StudioSteerLine>,
  payload: StudioRunPayload,
  sink: ReturnType<typeof routeStudioLines>,
): Promise<void> {
  try {
    for await (const line of source) {
      if (line.type === 'error') throw builderError(line);
      sink(line);
    }
  } catch (error) {
    const event = withPublicWording(toErrorEvent(error), payload.profile.labels);
    if (event.type === 'error') throw builderError(event);
    throw error;
  }
}

async function* recordLocalCheckpoints(
  source: AsyncIterable<TurnEvent | StudioTraceLine | StudioSteerLine>,
  local: ReturnType<typeof browserExecution> | undefined,
): AsyncGenerator<TurnEvent | StudioTraceLine | StudioSteerLine> {
  for await (const event of source) {
    if (local && (event.type === 'done' || event.type === 'provider_checkpoint') && event.providerState)
      await (await local.boundary).recordCheckpoint(event.providerState);
    yield event;
  }
}

function localPageResult(local: ReturnType<typeof browserExecution> | undefined) {
  return local ? async (result: import('../react/src/client/page-dispatch.ts').PageDispatchResult) => {
    await local.pageResult(result);
  } : undefined;
}

function withBrowserExecution(runtime: StudioBrowserRuntime) {
  const local = runtime.execution ? undefined : browserExecution();
  if (local) {
    const original = runtime;
    runtime = {
      mode: original.mode,
      providers: original.providers,
      providerDefinitions: original.providerDefinitions,
      decision: original.decision,
      signal: original.signal,
      resolveHost: original.resolveHost?.bind(original),
      remoteTools: original.remoteTools,
      hostOptions: original.hostOptions?.bind(original),
      provider: original.provider?.bind(original),
      onAgentCall: original.onAgentCall?.bind(original),
      execution: local.execution,
      pageExecution: local.pageExecution,
    };
  }
  return { runtime, local };
}

export function createBrowserStudioTransport(
  payload: StudioRunPayload,
  runtime: StudioBrowserRuntime,
  options: { traces?: TraceFeed } = {},
): TheoremTransport {
  const prepared = withBrowserExecution(runtime);
  runtime = prepared.runtime;
  const local = prepared.local;
  const traces = options.traces ?? createTraceFeed();
  const steer = createMemorySteerInbox();
  const inboxes = new Map<string, string>();
  const compiled = {
    profile: payload.profile,
    customTools: payload.customTools,
    structured: payload.structured,
    dependencies: payload.dependencies,
    runtime,
  };
  const route = (onEvent: TurnEventSink, onInbox = (_inbox: string) => {}) =>
    routeStudioLines(onEvent, traces, onInbox);
  return {
    pageResult: localPageResult(local),
    describe: () => Promise.resolve(studioInterface(payload)),
    async turn(request, onEvent, signal) {
      try {
        const providerState = local
          ? await (await local.boundary).prepareProviderState(request.providerState, request.input.history)
          : request.providerState;
        const source = streamStudioTurn({
          ...compiled,
          ...request,
          providerState,
          signal: runSignal(runtime, signal),
          steer,
          abandon: request.abandon?.map(({ callId, operationId }) => {
            const replay = request.replay?.abandon?.[operationId];
            if (!replay) {
              throw new TheoremError('request', 'No replay for abandoned call'); // labels-exempt: internal diagnostic
            }
            return { callId, operationId, replay };
          }),
        });
        await deliver(
          recordLocalCheckpoints(source, local),
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
        recordLocalCheckpoints(streamStudioInvoke({
          ...compiled,
          answer,
          signal: runSignal(runtime, signal),
        }), local),
        payload,
        route(onEvent),
      ),
    async steer(request) {
      const inbox = inboxes.get(request.turnId);
      if (!inbox || !(await steer.enqueue(inbox, steerUnitOf(request)))) {
        throw new TheoremError('request', 'The turn has ended', {
          copy: { key: 'session.turn_ended' },
        }); // labels-exempt: internal diagnostic
      }
    },
    traces,
  };
}

export function createBrowserStudioHostTransport(
  payload: StudioRunPayload,
  runtime: StudioBrowserRuntime,
  options: { traces?: TraceFeed } = {},
): HostTransport {
  const prepared = withBrowserExecution(runtime);
  runtime = prepared.runtime;
  const local = prepared.local;
  const traces = options.traces ?? createTraceFeed();
  let sessionPermissions: string[] = [];
  const compiled = {
    profile: payload.profile,
    customTools: payload.customTools,
    dependencies: payload.dependencies,
    runtime,
  };
  const route = (onEvent: TurnEventSink) => routeStudioLines(onEvent, traces, () => {});
  return {
    pageResult: localPageResult(local),
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
        streamStudioCall({
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
        streamStudioInvoke({
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

export function createBrowserStudioDecisionTransport(
  payload: StudioRunPayload,
  runtime: StudioBrowserRuntime,
  options: { traces?: TraceFeed } = {},
): DecisionTransport {
  const traces = options.traces ?? createTraceFeed();
  return {
    describe: () =>
      Promise.resolve(
        decisionInterface(
          defineProfile(payload.profile) as DecisionProfile,
          payload.questions ?? {},
        ),
      ),
    decide: (state, signal) =>
      runStudioDecision(payload, state, runtime.decision ?? {}, runSignal(runtime, signal)),
    traces,
  };
}
