import { browserExecution } from './browser-execution.ts';
import { type DecisionProfile, defineProfile, TheoremError, type TurnEvent } from '../mod.ts';
import {
  type DecisionTransport,
  decisionInterface,
} from '../react/src/client/decision-transport.ts';
import { type HostTransport, hostInterface } from '../react/src/client/host-transport.ts';
import { createTraceFeed, type TraceFeed } from '../react/src/client/trace-feed.ts';
import {
  type ChatLineSink,
  hostError,
  isTheoremStreamError,
  type TheoremTransport,
  type TurnEventSink,
} from '../react/src/client/transport.ts';
import { createSealedConversationStore } from '../react/src/server/conversation-store.ts';
import type { ReplyLine } from '../react/src/server/conversation.ts';
import { createMemorySteerInbox, steerUnitOf } from '../react/src/server/steer-inbox.ts';
import { clientError, forClient } from '../src/host/mod.ts';
import type { RunDecisionOptions } from '../src/kernel/engine/decision.ts';
import { STUDIO_READER } from './reader.ts';
import type { StudioRunPayload } from './run-payload.ts';
import {
  failedDecisionTraces,
  rewindStudio,
  runStudioDecision,
  streamStudioCall,
  streamStudioHostInvoke,
  streamStudioInvoke,
  streamStudioTurn,
  studioConversation,
  withFailedTraces,
} from './runtime.ts';
import type { StudioRuntimeBase } from './runtime-scope.ts';
import type { StudioTraceLine } from './traces.ts';
import {
  type StudioSteerLine,
  hostCallLines,
  routeStudioLines,
  studioInterface,
} from './transport.ts';

/** A run in the page: on the builder's own keys or machine, never on lent keys. */
export interface StudioBrowserRuntime extends StudioRuntimeBase {
  mode: 'byok' | 'local';
  decision?: Pick<RunDecisionOptions, 'vault' | 'fetch'>;
  /** Disconnecting aborts active requests, without retaining the vault in a saved payload. */
  signal?: AbortSignal;
}

/** The run's signal: the disconnect's and the request's, either of which aborts it. */
function runSignal(runtime: StudioBrowserRuntime, signal?: AbortSignal): AbortSignal {
  return AbortSignal.any([runtime.signal, signal].filter((each) => each !== undefined));
}

/** A failure of a run made in the page, as the studio's reader has it. */
function failed(error: unknown, payload: StudioRunPayload): Error {
  return hostError(clientError(error, payload.profile.labels, STUDIO_READER), 'internal');
}

/** Direct streams use the same event and trace routing as the HTTP transport. */
async function deliver(
  source: AsyncIterable<ReplyLine | StudioTraceLine | StudioSteerLine>,
  payload: StudioRunPayload,
  sink: ReturnType<typeof routeStudioLines>,
): Promise<void> {
  try {
    for await (const line of source) {
      const read =
        line.type === 'trace' || line.type === 'steer_inbox' || line.type === 'conversation'
          ? line
          : forClient(line, STUDIO_READER);
      if (read.type === 'error') throw hostError(read, 'internal');
      sink(read);
    }
  } catch (error) {
    throw isTheoremStreamError(error) ? error : failed(error, payload);
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

/** The one session a page's conversations open in: the tab holds the key, so only its refs open. */
const PAGE_SESSION = 'studio-page';

/**
 * A chat run in the page. Its conversation is sealed with `conversationKey`,
 * a key the tab keeps, so every transport of the tab opens the same refs.
 */
export function createBrowserStudioTransport(
  payload: StudioRunPayload,
  runtime: StudioBrowserRuntime,
  options: { conversationKey: string; traces?: TraceFeed },
): TheoremTransport {
  const prepared = withBrowserExecution(runtime);
  runtime = prepared.runtime;
  const local = prepared.local;
  const traces = options.traces ?? createTraceFeed();
  const steer = createMemorySteerInbox();
  const inboxes = new Map<string, string>();
  const conversations = {
    sessionId: PAGE_SESSION,
    store: createSealedConversationStore({ keys: { 1: options.conversationKey }, keyVersion: 1 }),
  };
  const compiled = {
    profile: payload.profile,
    customTools: payload.customTools,
    structured: payload.structured,
    dependencies: payload.dependencies,
    runtime,
  };
  const route = (onLine: ChatLineSink, onInbox = (_inbox: string) => {}) =>
    routeStudioLines(onLine, traces, onInbox);
  /** A request the page answers at once: its failure as the studio's reader has it. */
  const answered = async <T>(answer: () => Promise<T>): Promise<T> => {
    try {
      return await answer();
    } catch (error) {
      throw failed(error, payload);
    }
  };
  return {
    pageResult: localPageResult(local),
    describe: () => Promise.resolve(studioInterface(payload)),
    async turn(request, onEvent, signal) {
      try {
        await deliver(
          streamStudioTurn({
            ...compiled,
            request,
            conversations,
            signal: runSignal(runtime, signal),
            steer,
          }),
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
        streamStudioInvoke({
          ...compiled,
          answer,
          conversations,
          signal: runSignal(runtime, signal),
        }),
        payload,
        route(onEvent),
      ),
    conversation: (request) =>
      answered(() => studioConversation(compiled, conversations, request)),
    rewind: (request, signal) =>
      answered(() =>
        rewindStudio(compiled, conversations, request, runSignal(runtime, signal)),
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
  const route = (onEvent: TurnEventSink) =>
    routeStudioLines(hostCallLines(onEvent), traces, () => {});
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
        streamStudioHostInvoke({
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
    decide: async (state, signal) => {
      try {
        return await runStudioDecision(payload, state, runtime.decision ?? {}, runSignal(runtime, signal));
      } catch (err) {
        // The failure keeps the trace the kernel left.
        throw withFailedTraces(failed(err, payload), failedDecisionTraces(err));
      }
    },
    traces,
  };
}
