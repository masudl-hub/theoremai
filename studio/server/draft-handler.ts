/**
 * The studio screen's server: everything the screen asks a server for, from one handler.
 *
 * The screen authors each draft in the browser and sends it with every request, so this serves
 * no project. It always answers the guardrail probe, the key test and the tool connection test.
 * Given lent keys, it also runs drafts on them: chats, calls, decisions and embeddings. Without
 * them, the screen runs on the builder's own keys in the browser, and those routes answer 404.
 *
 * The host keeps its own policy: which keys it lends and how much anyone may spend on them
 * (`spend`). The handler keeps the plumbing.
 *
 * @module
 */
import { type ProfileDefinition, type ResolveHost, TheoremError, z } from '@theoremjs/agents';
import { clientError } from '@theoremjs/agents/host';
import type { TranscriptBlock } from '@theoremjs/agents/interface';
import {
  checkRequest,
  createMemoryPageToolBroker,
  createMemorySessionStore,
  createMemorySteerInbox,
  createSealedConversationStore,
  createTheoremSessionBoundary,
  type PageToolBroker,
  pageToolResultSchema,
  readBody,
  type SteerInbox,
  steerUnitOf,
  theoremConversationRequestSchema,
  theoremHostCallRequestSchema,
  theoremInvokeRequestSchema,
  theoremRewindRequestSchema,
  type TheoremSessionBoundary,
  type TheoremSessionStore,
  theoremSteerRequestSchema,
  theoremTurnRequestSchema,
} from '@theoremjs/react/server';
import { newConversationKey } from '../conversation-key.ts';
import type { LentKeys } from '../lent-keys.ts';
import type { StructuredRegistration, ToolRegistration } from '../registrations.ts';
import {
  rewindStudio,
  startStudioConversation,
  streamStudioCall,
  streamStudioHostInvoke,
  streamStudioInvoke,
  streamStudioTurn,
  studioConversation,
} from '../runtime.ts';
import type { StudioDependency, StudioRuntime } from '../runtime-scope.ts';
import { draftDecide } from './draft-decide.ts';
import { draftEmbedding } from './draft-embedding.ts';
import { draftProbe, type ProbeEntry } from './draft-probe.ts';
import { errorJson, ndjsonEventStream } from './draft-replies.ts';
import { testConnection } from './test-connection.ts';
import { testKey } from './test-key.ts';

export type { ProbeEntry } from './draft-probe.ts';

/** Runs on keys the host lends, and what they are held to. */
export type LentRuntime = StudioRuntime & { mode: 'demo'; keys: LentKeys };

/** What a request spends of the host's allowance: a decision, a host tool call, or an agent tool's model turn. */
export type StudioSpend = 'decision' | 'call' | 'agent';

export type StudioDraftHandlerOptions = {
  /**
   * Runs on the keys the host lends: `{ mode: 'demo', keys }`, with `hostOptions` filling each
   * profile's key slots, and the host's tool handlers. Without it, no draft runs on the server.
   */
  lent?: LentRuntime;
  /**
   * Spends one of `kind` for whoever sent `request`, before it runs. Throw a `TheoremError` to refuse
   * it: the screen reads the error's wording. Every decision, host tool call and agent tool turn on
   * the lent keys passes through it. Default: nothing is counted.
   */
  spend?: (kind: StudioSpend, request: Request) => void | Promise<void>;
  /**
   * Resolves the names the tool connection test calls, so the network guard refuses one that
   * answers a private address. Workers have no DNS lookup: pass `dnsOverHttpsResolver(...)`.
   * Default: `lent.resolveHost`.
   */
  resolveHost?: ResolveHost;
  /** Gets each probed text some guardrail boundary let through, after the answer. */
  onProbePassed?: (entry: ProbeEntry, at: Date) => Promise<void>;
  /** Where visitor sessions are kept. Default: in memory, for this handler's lifetime. */
  sessionStore?: TheoremSessionStore;
  /** Where page tool results wait for their run. Default: in memory. */
  pageToolBroker?: PageToolBroker;
  /**
   * Where a running chat's steers queue, by the inbox id the run sends its page. A host on several
   * isolates needs one store they all reach. Default: in memory.
   */
  steer?: SteerInbox;
  /** The key chat conversations are sealed with. Default: a new one, for this handler's lifetime. */
  conversationKey?: string;
  /** Where the handler is mounted. Default `/api/studio`. */
  base?: string;
};

/**
 * Answers a request under the base; `defer` keeps work running after the reply (a Worker's
 * `ctx.waitUntil`). A path it does not serve answers 404.
 */
export type StudioDraftHandler = {
  (request: Request, defer?: (work: Promise<unknown>) => void): Promise<Response>;
  /**
   * Opens a chat on `blocks` the host wrote, in the asking visitor's session, read first by the
   * draft's guardrails: `{ conversation, view }`. The request body is the draft. Needs `lent`.
   */
  startConversation(request: Request, blocks: readonly TranscriptBlock[]): Promise<Response>;
};

/** The draft every studio request carries beside its Theorem request: the browser authors it, so the server compiles it per request. */
type DraftBody = {
  profile: ProfileDefinition;
  customTools?: ToolRegistration[];
  structured?: StructuredRegistration;
  /** The agents this one's agent tools and compaction name, registered before it. */
  dependencies?: StudioDependency[];
  sessionPermissions?: unknown;
};

/** The tools a page allowed for the rest of its visit, as the browser holds them. */
const pagePermissions = z.array(z.string().min(1).max(128)).max(256).optional();

/** The labels a failed request's reply is worded with: its draft's, once the body is read. */
function draftLabels(draft: DraftBody | undefined): ProfileDefinition['labels'] {
  // The body is unchecked when most failures are caught, so the draft may hold anything.
  return (draft as { profile?: Partial<ProfileDefinition> } | null | undefined)?.profile?.labels;
}

const notFound = () => Response.json({}, { status: 404 });

/** Where the screen asks unless the host mounts the handler elsewhere. */
export const STUDIO_BASE = '/api/studio';

/** Serves the studio screen's requests. */
export function createStudioDraftHandler(options: StudioDraftHandlerOptions = {}): StudioDraftHandler {
  const base = (options.base ?? STUDIO_BASE).replace(/\/$/, '');
  const { lent, spend } = options;
  const resolveHost = options.resolveHost ?? lent?.resolveHost;
  const sessionStore = options.sessionStore ?? createMemorySessionStore();
  const pageToolBroker = options.pageToolBroker ?? createMemoryPageToolBroker();
  const steer = options.steer ?? createMemorySteerInbox();
  const conversationStore = createSealedConversationStore({
    keys: { 1: options.conversationKey ?? newConversationKey() },
    keyVersion: 1,
  });

  const conversationsOf = (boundary: TheoremSessionBoundary) => ({
    sessionId: boundary.sessionId,
    store: conversationStore,
  });

  /** Each agent tool call runs a model turn on the lent keys, so it spends first; a refusal is what the calling model reads. */
  const agentCall = (request: Request): StudioRuntime['onAgentCall'] =>
    spend &&
    (async () => {
      try {
        await spend('agent', request);
        return undefined;
      } catch (err) {
        return { refuse: clientError(err).error };
      }
    });

  /** The run's runtime: the lent keys, on this session's tool execution. */
  const runtimeOf = (lent: LentRuntime, boundary: TheoremSessionBoundary, request: Request): StudioRuntime => ({
    ...lent,
    execution: boundary.toolExecution,
    pageExecution: boundary.pageExecution,
    onAgentCall: agentCall(request),
  });

  /** A draft as a run takes it. */
  const draftRun = (lent: LentRuntime, draft: DraftBody, boundary: TheoremSessionBoundary, request: Request) => ({
    profile: draft.profile,
    customTools: draft.customTools ?? [],
    structured: draft.structured,
    dependencies: draft.dependencies,
    runtime: runtimeOf(lent, boundary, request),
  });

  /** A draft request: its body read, its session opened, the cookie set, and a failure worded with the draft's labels. */
  const draftRequest = async (
    request: Request,
    handle: (draft: DraftBody, boundary: TheoremSessionBoundary) => Response | Promise<Response>,
  ): Promise<Response> => {
    let draft: DraftBody | undefined;
    try {
      draft = (await readBody(request, z.unknown())) as DraftBody;
      const boundary = await createTheoremSessionBoundary({ request, sessionStore, pageToolBroker });
      const response = await handle(draft, boundary);
      if (boundary.setCookie) response.headers.append('set-cookie', boundary.setCookie);
      return response;
    } catch (err) {
      return errorJson(err, draftLabels(draft));
    }
  };

  /** A run's events, streamed, with each checkpoint the run reaches kept in the session. */
  const stream = (boundary: TheoremSessionBoundary, draft: DraftBody, events: AsyncIterable<{ type: string }>) =>
    ndjsonEventStream(recorded(boundary, events), draft.profile.labels);

  const lentRoutes = (lent: LentRuntime): Record<string, (request: Request) => Promise<Response>> => ({
    turn: (request) =>
      draftRequest(request, (draft, boundary) =>
        stream(
          boundary,
          draft,
          streamStudioTurn({
            ...draftRun(lent, draft, boundary, request),
            request: checkRequest(theoremTurnRequestSchema, draft, 'request body'),
            conversations: conversationsOf(boundary),
            signal: request.signal,
            steer,
          }),
        )),
    invoke: (request) =>
      draftRequest(request, (draft, boundary) => {
        const answer = checkRequest(theoremInvokeRequestSchema, draft, 'request body');
        const run = draftRun(lent, draft, boundary, request);
        return stream(
          boundary,
          draft,
          draft.profile.type === 'host'
            ? streamStudioHostInvoke({ ...run, answer, signal: request.signal })
            : streamStudioInvoke({ ...run, answer, conversations: conversationsOf(boundary), signal: request.signal }),
        );
      }),
    conversation: (request) =>
      draftRequest(request, async (draft, boundary) =>
        Response.json(
          await studioConversation(
            draftRun(lent, draft, boundary, request),
            conversationsOf(boundary),
            checkRequest(theoremConversationRequestSchema, draft, 'request body'),
          ),
        )),
    rewind: (request) =>
      draftRequest(request, async (draft, boundary) =>
        Response.json(
          await rewindStudio(
            draftRun(lent, draft, boundary, request),
            conversationsOf(boundary),
            checkRequest(theoremRewindRequestSchema, draft, 'request body'),
            request.signal,
          ),
        )),
    call: (request) =>
      draftRequest(request, async (draft, boundary) => {
        const call = checkRequest(theoremHostCallRequestSchema, draft, 'request body');
        const sessionPermissions = checkRequest(pagePermissions, draft.sessionPermissions, 'session permissions');
        // Counted only once the request is one a host would run.
        await spend?.('call', request);
        const { structured: _structured, ...run } = draftRun(lent, draft, boundary, request);
        return stream(
          boundary,
          draft,
          streamStudioCall({ ...run, call, sessionPermissions, signal: request.signal }),
        );
      }),
    'turn/steer': async (request) => {
      try {
        // The inbox the server opened for the turn is the turn id the browser steers.
        const asked = checkRequest(theoremSteerRequestSchema, await readBody(request, z.unknown()), 'request body');
        if (!(await steer.enqueue(asked.turnId, steerUnitOf(asked)))) {
          // labels-exempt: internal diagnostic; the user reads session.turn_ended
          throw new TheoremError('request', 'steer: no open run has this inbox', { copy: { key: 'session.turn_ended' } });
        }
        return Response.json({ ok: true });
      } catch (err) {
        return errorJson(err);
      }
    },
    'page-result': async (request) => {
      try {
        const boundary = await createTheoremSessionBoundary({ request, sessionStore, pageToolBroker });
        await boundary.answerPageResult(await readBody(request, pageToolResultSchema));
        const response = Response.json({ accepted: true });
        if (boundary.setCookie) response.headers.append('set-cookie', boundary.setCookie);
        return response;
      } catch (err) {
        return errorJson(err);
      }
    },
    decide: (request) =>
      draftDecide(request, { runtime: lent, spend: async (asked) => await spend?.('decision', asked) }),
    'embedding/embed': (request) => draftEmbedding(request, lent),
  });

  const handler = ((request, defer) => {
    const path = new URL(request.url).pathname;
    const route = path.startsWith(`${base}/`) ? path.slice(base.length + 1) : '';
    const routes: Record<string, (request: Request) => Promise<Response>> = {
      probe: (asked) => draftProbe(asked, options.onProbePassed, defer ?? (() => {})),
      'test-key': testKey,
      'test-connection': (asked) => testConnection(asked, resolveHost),
      ...(lent ? lentRoutes(lent) : {}),
    };
    if (!Object.hasOwn(routes, route)) return Promise.resolve(notFound());
    if (request.method !== 'POST') return Promise.resolve(new Response(null, { status: 405 }));
    return routes[route](request);
  }) as StudioDraftHandler;

  handler.startConversation = (request, blocks) => {
    if (!lent) return Promise.resolve(notFound());
    return draftRequest(request, async (draft, boundary) =>
      Response.json(
        await startStudioConversation(draftRun(lent, draft, boundary, request), conversationsOf(boundary), blocks),
      ));
  };
  return handler;
}

/** The run's events, with each checkpoint it reaches kept in the visitor's session. */
async function* recorded<T extends { type: string }>(
  boundary: TheoremSessionBoundary,
  events: AsyncIterable<T>,
): AsyncGenerator<T> {
  for await (const event of events) {
    if (event.type === 'done' || event.type === 'provider_checkpoint') {
      const state = (event as { providerState?: Parameters<TheoremSessionBoundary['recordCheckpoint']>[0] })
        .providerState;
      if (state) await boundary.recordCheckpoint(state);
    }
    yield event;
  }
}
