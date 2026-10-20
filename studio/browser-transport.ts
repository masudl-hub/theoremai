import { type DecisionProfile, defineProfile, TheoremError } from '@theoremjs/agents';
import { clientError, forClient } from '@theoremjs/agents/host';
import type { RunDecisionOptions } from '@theoremjs/agents/kernel';
import {
  type ChatLineSink,
  createTraceFeed,
  type DecisionTransport,
  decisionInterface,
  type EmbeddingTransport,
  embeddingInterface,
  failedTraces,
  type HostTransport,
  hostError,
  hostInterface,
  isTheoremStreamError,
  type TheoremTransport,
  type TraceFeed,
  type TurnEventSink,
  withFailedTraces,
} from '@theoremjs/react/client';
import type { ReplyLine } from '@theoremjs/react/server';
import { STUDIO_READER } from './reader.ts';
import type { StudioRunPayload } from './run-payload.ts';
import type { StudioRuntimeBase } from './runtime-scope.ts';
import type { StudioTraceLine } from './traces.ts';
import {
  hostCallLines,
  routeStudioLines,
  type StudioSteerLine,
  studioInterface,
} from './transport.ts';

let engine: Promise<typeof import('./browser-engine.ts')> | undefined;
/**
 * The engine a run in the page runs on, loaded once. A connection asks for it as it is made, so
 * the first run waits on nothing; a studio that never runs in the page never downloads it.
 */
export const browserEngine = (): Promise<typeof import('./browser-engine.ts')> =>
  (engine ??= import('./browser-engine.ts'));

/** The lines `open` streams once `ready` settles: a run's lines wait for the engine it runs on. */
async function* after<S, T>(
  ready: Promise<S>,
  open: (ready: S) => AsyncIterable<T>,
): AsyncIterable<T> {
  yield* open(await ready);
}

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

type Engine = typeof import('./browser-engine.ts');
type LocalExecution = ReturnType<Engine['browserExecution']>;

/** A page tool's answer goes to the page's own sessions, once the engine they live in has loaded. */
function localPageResult(
  runtime: StudioBrowserRuntime,
  local: () => Promise<LocalExecution | undefined>,
) {
  return runtime.execution
    ? undefined
    : async (result: import('@theoremjs/react/client').PageDispatchResult) => {
        await (await local())?.pageResult(result);
      };
}

function withBrowserExecution(runtime: StudioBrowserRuntime, run: Engine) {
  const local = runtime.execution ? undefined : run.browserExecution();
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
  const traces = options.traces ?? createTraceFeed();
  // The engine starts loading as the transport is made, when the builder connects.
  const session = browserEngine().then((run) => ({
    run,
    ...withBrowserExecution(runtime, run),
    steer: run.createMemorySteerInbox(),
    conversations: {
      sessionId: PAGE_SESSION,
      store: run.createSealedConversationStore({
        keys: { 1: options.conversationKey },
        keyVersion: 1,
      }),
    },
  }));
  // why: a failed load surfaces on the run that awaits it, not as an unhandled rejection.
  session.catch(() => {});
  const inboxes = new Map<string, string>();
  const compiled = {
    profile: payload.profile,
    customTools: payload.customTools,
    structured: payload.structured,
    dependencies: payload.dependencies,
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
    pageResult: localPageResult(runtime, async () => (await session).local),
    describe: () => Promise.resolve(studioInterface(payload)),
    async turn(request, onEvent, signal) {
      try {
        await deliver(
          after(session, ({ run, runtime: inPage, conversations, steer }) =>
            run.streamStudioTurn({
              ...compiled,
              runtime: inPage,
              request,
              conversations,
              signal: runSignal(runtime, signal),
              steer,
            }),
          ),
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
        after(session, ({ run, runtime: inPage, conversations }) =>
          run.streamStudioInvoke({
            ...compiled,
            runtime: inPage,
            answer,
            conversations,
            signal: runSignal(runtime, signal),
          }),
        ),
        payload,
        route(onEvent),
      ),
    conversation: (request) =>
      answered(async () => {
        const { run, runtime: inPage, conversations } = await session;
        return run.studioConversation({ ...compiled, runtime: inPage }, conversations, request);
      }),
    rewind: (request, signal) =>
      answered(async () => {
        const { run, runtime: inPage, conversations } = await session;
        return run.rewindStudio(
          { ...compiled, runtime: inPage },
          conversations,
          request,
          runSignal(runtime, signal),
        );
      }),
    async steer(request) {
      const inbox = inboxes.get(request.turnId);
      const { run, steer } = await session;
      if (!inbox || !(await steer.enqueue(inbox, run.steerUnitOf(request)))) {
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
  const traces = options.traces ?? createTraceFeed();
  let sessionPermissions: string[] = [];
  let prepared: Promise<{ run: Engine } & ReturnType<typeof withBrowserExecution>> | undefined;
  /** The engine and the page's sessions, made on the first call and kept for the rest. */
  const prepare = () =>
    (prepared ??= browserEngine().then((run) => ({ run, ...withBrowserExecution(runtime, run) })));
  const compiled = {
    profile: payload.profile,
    customTools: payload.customTools,
    dependencies: payload.dependencies,
  };
  const route = (onEvent: TurnEventSink) =>
    routeStudioLines(hostCallLines(onEvent), traces, () => {});
  return {
    pageResult: localPageResult(runtime, async () => (await prepare()).local),
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
        after(prepare(), ({ run, runtime: inPage }) =>
          run.streamStudioCall({
            ...compiled,
            runtime: inPage,
            call,
            sessionPermissions,
            signal: runSignal(runtime, signal),
          }),
        ),
        payload,
        route(onEvent),
      ),
    invoke(answer, onEvent, signal) {
      sessionPermissions = answer.replay?.sessionPermissions ?? sessionPermissions;
      return deliver(
        after(prepare(), ({ run, runtime: inPage }) =>
          run.streamStudioHostInvoke({
            ...compiled,
            runtime: inPage,
            answer,
            signal: runSignal(runtime, signal),
          }),
        ),
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
          payload.images,
        ),
      ),
    decide: async (state, signal, assets) => {
      try {
        const run = await browserEngine();
        return await run.runStudioDecision(
          payload,
          state,
          runtime.decision ?? {},
          runSignal(runtime, signal),
          assets,
        );
      } catch (err) {
        // The failure keeps the trace the kernel left.
        throw withFailedTraces(failed(err, payload), failedTraces(err));
      }
    },
    traces,
  };
}

export function createBrowserStudioEmbeddingTransport(
  payload: StudioRunPayload,
  runtime: StudioBrowserRuntime,
  options: { traces?: TraceFeed } = {},
): EmbeddingTransport {
  const traces = options.traces ?? createTraceFeed();
  return {
    describe: () =>
      Promise.resolve(
        embeddingInterface(
          defineProfile(payload.profile) as Extract<
            ReturnType<typeof defineProfile>,
            { type: 'embedding' }
          >,
        ),
      ),
    embed: async (input, embed, signal) => {
      try {
        const run = await browserEngine();
        const response = await run.runStudioEmbedding(
          payload,
          {
            input,
            ...embed,
            signal: runSignal(runtime, signal),
          },
          withBrowserExecution(runtime, run).runtime,
        );
        return { result: response.result, traces: response.traces };
      } catch (error) {
        throw withFailedTraces(failed(error, payload), failedTraces(error));
      }
    },
    traces,
  };
}
