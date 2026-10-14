import { withPublicLabels } from '@theoremjs/agents/guardrails';
import {
  createMemoryPageToolBroker,
  type PageToolBroker,
  pageToolResultSchema,
  sessionPageDispatch,
} from './page-dispatch.ts';
/**
 * One Web-standard handler that serves a Theorem chat UI for a single profile.
 *
 * Mount it on any framework that speaks `Request` → `Response` (Deno.serve,
 * Hono, Next route handlers, SvelteKit, Workers) under a catch-all route:
 *
 * - `GET  <base>`         → `{ interface }` client-safe profile interface
 * - `POST <base>/turn`    → NDJSON turn events; a message sent while the reply
 *                            waits on gates walks away from them first (`abandon`)
 * - `POST <base>/invoke`  → NDJSON events for the user's answer to a paused tool call
 * - `POST <base>/steer`   → inject messages into a running turn
 * - `POST <base>/conversation` → the transcript and the paused reply, to draw
 * - `POST <base>/rewind`  → `{ conversation, view }` the conversation cut after one block, and its new ref
 *
 * `createTheoremHostHandler` serves a host profile the same way, with no model:
 *
 * - `GET  <base>`         → `{ interface }` the tools the page may call, with their schemas
 * - `POST <base>/call`    → NDJSON events for one call of one of those tools
 * - `POST <base>/invoke`  → NDJSON events for the user's answer to a paused call
 * - `POST <base>/page-result` → grant-correlated browser result receipt
 *
 * Trust boundary: the host owns the conversation and every decision that grants
 * authority. Two stores keep them. The `conversationStore` owns the transcript,
 * the history the model reads and the paused reply; the browser sends only what
 * the person did now, with the opaque ref the store issued. The session store
 * owns which paused calls may run (and with what input) and the tool
 * permissions — request bodies can't grant any of them. A profile whose `providerContinuation.history` is
 * `'stateless'` keeps no conversation, and takes no store.
 * Tool credentials are held on the server too: a key the user types at a gate
 * is sent once and saved, and no credential is ever sent back to the browser.
 *
 * @module
 */

import {
  attachmentsRefused,
  authorizeToolReplay,
  compactHistory,
  defaultKernelScope,
  defineProfile,
  type GateReference,
  invokeTool,
  jsonObjectSchema,
  labelText,
  type Profile,
  type ProfileDefinition,
  type ProviderHostOptions,
  registerProfile,
  runTurn,
  TheoremError,
  type ToolGate,
  type TurnEvent,
  type TurnInput,
  toolInvocationHash,
  type z,
} from '@theoremjs/agents';
import {
  type ClientError,
  type ClientTurnOptions,
  caughtStatus,
  clientError,
  forClient,
  HTTP_METHOD,
} from '@theoremjs/agents/host';
import {
  type ComposerProfileInterface,
  clientProfileInterface,
  gatedToolsFromEvents,
  interfaceFromProfile,
  type PendingAttachment,
  prepareUserTurn,
  promotedToolIdsFromEvents,
  streamThoughtsEnabled,
  toolSnapshotFromEvents,
} from '@theoremjs/agents/interface';
import {
  type AnsweredGate,
  answerGatedCall,
  base64ToBytes,
  type GateAnswerRequest,
  resolveGateTtlMs,
  type ToolCredentialSource,
} from '@theoremjs/agents/kernel';
import {
  hostInterface,
  type TheoremHostCallRequest,
  theoremHostCallRequestSchema,
} from '../client/host-transport.ts';
import {
  type EncodedBlob,
  type TheoremInvokeRequest,
  type TheoremRewound,
  type TheoremTurnInput,
  theoremConversationRequestSchema,
  theoremInvokeRequestSchema,
  theoremRewindRequestSchema,
  theoremSteerRequestSchema,
  theoremTurnRequestSchema,
} from '../client/transport.ts';
import {
  answerReply,
  type ConversationHost,
  conversationView,
  type IssuedWalkAway,
  messageReply,
  openConversation,
  type PostedMessage,
  type ReplyLine,
  type ReplyRunner,
  type ReplyTurn,
  requireRewindPoint,
  requireWaitingOn,
  requireWalkAway,
  rewindConversation,
  waitingCalls,
} from './conversation.ts';
import { type TheoremConversationStore, unknownConversation } from './conversation-store.ts';
import {
  createMemoryCredentialStore,
  type TheoremCredentialStore,
  type TheoremCredentials,
} from './credential-store.ts';
import { type MutableStore, sessionStateStore } from './session-authority.ts';
import { cookieSession, type Session } from './session-identity.ts';

export { theoremSessionId } from './session-identity.ts';

import { jsonResponse } from './json-response.ts';
import { boundedRequestJson, requestByteLimit } from './request-body.ts';
import { checkRequest } from './request-check.ts';
import { resolveSessionLimits, type TheoremSessionLimits } from './session-limits.ts';
import {
  createMemorySessionStore,
  DEFAULT_OPERATION_RETENTION_MS,
  type PendingToolGate,
  type PerSessionStore,
  type SessionToolOperation,
  type TheoremSessionState,
  type TheoremSessionStore,
} from './session-store.ts';
import { createMemorySteerInbox, type SteerInbox, steerStage, steerUnitOf } from './steer-inbox.ts';
import { sameAcceptedAnswer, sessionToolCoordinator } from './tool-operations.ts';
import { kernelTurnInput } from './turn-input.ts';

export type TheoremRequestContext = {
  request: Request;
  /** Selected model id, when the client picked one. */
  model?: string;
};

export type TheoremHandlerOptions = {
  /** Profile to serve. Registered with the kernel when the handler is created. */
  profile: Profile | ProfileDefinition;
  /**
   * Host options for registered providers, or a factory for hosts that
   * pick keys per request (BYOK, tenant vaults). Tools are registered by the host.
   */
  provider:
    | ProviderHostOptions
    | ((ctx: TheoremRequestContext) => ProviderHostOptions | Promise<ProviderHostOptions>);
  /** Opaque app context for tool handlers (`ctx.host`) — e.g. the signed-in user. */
  host?: (request: Request) => unknown;
  /**
   * What the host wants the agent to know on each turn: any JSON. The profile's
   * `inputs.context.from` must list `server`. The page's own context arrives in the
   * request and is read as untrusted; this one is the host's.
   */
  context?: (request: Request) => unknown;
  /**
   * Resolve the caller's session id — e.g. `${userId}:${conversationId}` from your
   * auth. Return `undefined` to refuse the request (401). Default: an opaque id
   * in an HttpOnly, SameSite=Lax cookie the handler issues on first contact.
   */
  session?: (request: Request) => string | undefined | Promise<string | undefined>;
  /** Default: in-process memory. Use a shared store when requests can reach different instances. */
  sessionStore?: TheoremSessionStore;
  /**
   * Where the chat's conversation lives: the transcript, the history the model
   * reads and a reply paused on gates. Required unless the profile's
   * `providerContinuation.history` is `'stateless'`, which keeps none and takes
   * no store. `createMemoryConversationStore` for one instance,
   * `createSealedConversationStore` to keep nothing on the server, or your
   * own database.
   */
  conversationStore?: TheoremConversationStore;
  /**
   * How long a gate (permission, confirmation, sign-in) waits for its answer, in
   * milliseconds. An answer after that is refused with `session.gate_expired`.
   * Default: 30 minutes.
   */
  gateTtlMs?: number;
  /** Retain settled tool results in milliseconds. Default: 24 hours. */
  operationRetentionMs?: number;
  /** Finite per-session bounds. Unresolved authority is never evicted to satisfy them. */
  sessionLimits?: Partial<TheoremSessionLimits>;
  /** Maximum UTF-8 request body bytes before JSON parsing. Default: 16 MiB. */
  maxRequestBytes?: number;
  pageToolBroker?: PageToolBroker;
  /** Check current resource access before disclosing a saved tool result. This callback must be read-only. */
  authorizeToolReplay?: (context: {
    request: Request;
    operation: Extract<SessionToolOperation, { status: 'settled' }>;
  }) => boolean | Promise<boolean>;
  /**
   * Tool credentials by session. Your OAuth callback route saves the token here
   * under the same session id; every turn reads from here. Default: in-process
   * memory — pass the same instance to your callback route.
   */
  credentialStore?: TheoremCredentialStore;
  /**
   * The sign-in URL for an OAuth gate: begin the flow with `createOAuthPkceFlow`,
   * binding it to `sessionId`, and return its `authorizationUrl`. Without it an
   * OAuth gate carries no sign-in URL.
   */
  authorizationUrl?: (
    challenge: Extract<ToolGate, { kind: 'auth' }>['authChallenge'],
    ctx: { request: Request; sessionId: string },
  ) => string | Promise<string>;
  /** Default: in-process memory. Use a shared store when turns and steers can land on different instances. */
  steerInbox?: SteerInbox;
  /**
   * Who reads this host's replies, and what an event keeps for them: forwarded to `forClient`
   * for each event and to `clientError` for a failure the handler catches.
   */
  clientEvents?: ClientTurnOptions;
  /**
   * Called with any error the handler catches, for reporting. Users read the
   * profile's labels wording for the error's kind, never the error itself.
   */
  onError?: (err: unknown, ctx: { request: Request }) => void;
};

/** A host profile runs no model, and takes no turns to steer. */
export type TheoremHostHandlerOptions = Omit<
  TheoremHandlerOptions,
  'profile' | 'provider' | 'steerInbox' | 'conversationStore'
> & {
  /** Host profile to serve. Registered with the kernel when the handler is created. */
  profile: Extract<Profile, { type: 'host' }> | Extract<ProfileDefinition, { type: 'host' }>;
};

const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-store',
} as const;

function withSessionCookie(response: Response, session: Session | undefined): Response {
  if (session?.setCookie) response.headers.append('set-cookie', session.setCookie);
  return response;
}

/** A JSON body checked against `schema`; a missing or malformed field is a `request` error (400). */
export async function readBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes?: number,
): Promise<T> {
  // why: JSON-only POSTs can't be sent by a cross-site form, and force a CORS preflight.
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    // labels-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
    throw new TheoremError('request', 'Content-Type must be application/json');
  }
  let raw: unknown;
  try {
    raw = await boundedRequestJson(request, requestByteLimit(maxBytes));
  } catch (error) {
    if (error instanceof TheoremError) throw error;
    // invariant: A JSON parser's message can contain request values and must not enter diagnostics.
    throw new TheoremError('request', labelText('error.request'), {
      cause: { code: 'request_json' },
    });
  }
  return checkRequest(schema, raw, 'request body');
}

/** Last path segment after the mount point: '', a chat's route, or a host's 'call'. */
function routeOf(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const last = segments.at(-1) ?? '';
  return last === 'turn' ||
    last === 'invoke' ||
    last === 'steer' ||
    last === 'conversation' ||
    last === 'rewind' ||
    last === 'call' ||
    last === 'page-result'
    ? last
    : '';
}

function lockedStore<T>(
  store: PerSessionStore<T>,
  loaded: (value: T | undefined) => T,
): MutableStore<T> {
  const locks = new Map<string, Promise<unknown>>();
  const read = async (sessionId: string) => loaded(await store.load(sessionId));
  return {
    read,
    mutate(sessionId, change) {
      const next = (locks.get(sessionId) ?? Promise.resolve()).then(async () => {
        const value = await read(sessionId);
        const result = change(value);
        await store.save(sessionId, value);
        return result;
      });
      const settled = next.catch(() => {});
      locks.set(sessionId, settled);
      void settled.then(() => {
        if (locks.get(sessionId) === settled) locks.delete(sessionId);
      });
      return next;
    },
  };
}

/** A profile that takes messages. */
type ChatProfile = Exclude<Profile, { type: 'live' | 'decision' | 'host' }>;

/** What a chat's requests read beside the handler's own. */
type ChatContext = {
  profile: ChatProfile;
  /** Undefined when the profile keeps no conversation (`'stateless'`). */
  conversations?: TheoremConversationStore;
};

/** The profile as the server reads a message against it, its tools as registered now. */
function chatInterface(chat: ChatContext): ComposerProfileInterface {
  return interfaceFromProfile(chat.profile, defaultKernelScope.tools);
}

/** Everything a request needs from the handler that serves it. */
type HandlerContext = {
  /** A host's handler has no provider: it runs no model. */
  options: Omit<TheoremHandlerOptions, 'profile' | 'provider'> &
    Partial<Pick<TheoremHandlerOptions, 'provider'>>;
  profile: Profile;
  /** A chat's: none for a host profile, which takes no messages. */
  chat?: ChatContext;
  inbox: SteerInbox;
  sessions: MutableStore<TheoremSessionState>;
  pageToolBroker: PageToolBroker;
  credentials: MutableStore<TheoremCredentials>;
};

async function sessionOf(ctx: HandlerContext, request: Request): Promise<Session> {
  if (!ctx.options.session) return cookieSession(request);
  const id = (await ctx.options.session(request))?.trim();
  if (!id) {
    // labels-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
    throw new TheoremError('auth', 'the session resolver refused the request', {
      copy: { key: 'session.sign_in' },
    });
  }
  return { id };
}

/** Reports the error to the host, then words it for whoever reads this host's replies. */
function caughtError(ctx: HandlerContext, err: unknown, request: Request): ClientError {
  ctx.options.onError?.(err, { request });
  return clientError(err, ctx.profile.labels, ctx.options.clientEvents);
}

function eventStream(
  ctx: HandlerContext,
  request: Request,
  source: () => AsyncIterable<ReplyLine>,
): Response {
  const encoder = new TextEncoder();
  const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);
  // invariant: The source runs to its end after the browser goes, so a stopped reply still reaches its save.
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: unknown) => {
        if (!cancelled) controller.enqueue(line(value));
      };
      try {
        for await (const event of source()) {
          send(event.type === 'conversation' ? event : forClient(event, ctx.options.clientEvents));
        }
      } catch (err) {
        if (!request.signal.aborted) send({ type: 'error', ...caughtError(ctx, err, request) });
      }
      if (!cancelled) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return new Response(stream, { headers: NDJSON_HEADERS });
}

function providerFor(
  ctx: HandlerContext,
  request: Request,
  model?: string,
): ProviderHostOptions | Promise<ProviderHostOptions> {
  const { provider } = ctx.options;
  // labels-exempt: builder config error; the user reads error.config
  if (!provider) throw new TheoremError('config', `profile ${ctx.profile.id} has no provider`);
  if (typeof provider === 'function') return provider({ request, model });
  return provider;
}

/** Steer inboxes are scoped to the session, so a turn id alone can't reach another user's turn. */
function inboxKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

type OutcomeContext = {
  profileId: string;
  turnInput: TurnInput;
  model?: string;
  promoted?: string[];
};

function requiredOperationId(call: { operationId?: string }): string {
  if (!call.operationId) throw new TheoremError('internal', labelText('error.internal'));
  return call.operationId;
}

/** The exact paused calls the user may now approve, when the stream stopped on gates. */
function pendingGatesFrom(
  events: TurnEvent[],
  context: OutcomeContext,
): { callId: string; gate: PendingToolGate }[] {
  return gatedToolsFromEvents(events).map((gated) => ({
    callId: gated.callId,
    gate: {
      profileId: context.profileId,
      operationId: requiredOperationId(gated),
      callId: gated.callId,
      name: gated.name,
      arguments: gated.arguments,
      gate: {
        kind: gated.gateKind,
        permission: gated.permission,
        ...(gated.auth ? { auth: gated.auth } : {}),
      },
      snapshot: toolSnapshotFromEvents(events),
      promoted: [...new Set([...(context.promoted ?? []), ...promotedToolIdsFromEvents(events)])],
      turnInput: context.turnInput,
      model: context.model,
      createdAt: Date.now(),
    },
  }));
}

/** When the stream paused on gates, record the exact calls the user may now approve. */
async function recordOutcome(
  sessions: MutableStore<TheoremSessionState>,
  sessionId: string,
  events: TurnEvent[],
  context: OutcomeContext,
): Promise<void> {
  const pending = pendingGatesFrom(events, context);
  if (!pending.length) return;
  await sessions.mutate(sessionId, (state) => {
    for (const { gate } of pending) {
      const operation = state.operations[gate.operationId];
      if (operation && operation.status !== 'ready')
        throw new TheoremError('unavailable', labelText('error.unavailable'));
      delete state.operations[gate.operationId];
      Object.defineProperty(state.gates, gate.operationId, {
        value: gate,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  });
}

async function* recorded(
  sessions: MutableStore<TheoremSessionState>,
  sessionId: string,
  events: AsyncIterable<TurnEvent>,
  context: OutcomeContext,
  seed: TurnEvent[] = [],
): AsyncGenerator<TurnEvent> {
  const seen: TurnEvent[] = [...seed];
  for await (const event of events) {
    seen.push(event);
    if (event.type === 'done' || event.type === 'provider_checkpoint')
      await recordOutcome(sessions, sessionId, seen, context);
    yield event;
  }
}

/** Save one credential, leaving the session's others as they are. */
function saveCredential(
  ctx: HandlerContext,
  sessionId: string,
  slot: string,
  credential: TheoremCredentials[string],
): Promise<void> {
  return ctx.credentials.mutate(sessionId, (saved) => {
    saved[slot] = credential;
  });
}

/**
 * The session's credentials as a call reads them: one slot when a tool needs it,
 * saved the moment the kernel sets one, so a rotated refresh token is never lost
 * to a closed stream.
 */
function sessionCredentials(ctx: HandlerContext, sessionId: string): ToolCredentialSource {
  return {
    get: async (slot) => (await ctx.credentials.read(sessionId))[slot],
    set: (slot, credential) => saveCredential(ctx, sessionId, slot, credential),
  };
}

/** An OAuth gate given the host's sign-in URL. */
async function withAuthorizationUrl(
  ctx: HandlerContext,
  request: Request,
  sessionId: string,
  event: TurnEvent,
): Promise<TurnEvent> {
  if (event.type !== 'tool' || event.tool.phase !== 'gate') return event;
  const { tool } = event;
  const gate = tool.gate.kind === 'auth' ? tool.gate : undefined;
  if (gate?.authChallenge.authType !== 'oauth2' || !ctx.options.authorizationUrl) return event;
  const challenge = gate.authChallenge;
  const authorizationUrl = await ctx.options.authorizationUrl(challenge, { request, sessionId });
  return {
    ...event,
    tool: { ...tool, gate: { ...gate, authChallenge: { ...challenge, authorizationUrl } } },
  };
}

/** Every OAuth gate in the stream, given the host's sign-in URL. */
async function* withAuthorizationUrls(
  ctx: HandlerContext,
  request: Request,
  sessionId: string,
  events: AsyncIterable<TurnEvent>,
): AsyncGenerator<TurnEvent> {
  for await (const event of events)
    yield await withAuthorizationUrl(ctx, request, sessionId, event);
}

/** The session's paused call, answered and taken out: each answer settles it once, as the model asked it. */
type AnsweredCall = { callId: string; pending: PendingToolGate; answer: AnsweredGate };

function answerPendingGate(
  state: TheoremSessionState,
  request: GateAnswerRequest & GateReference,
  profileId: string,
): AnsweredCall {
  const operation = Object.hasOwn(state.operations, request.operationId)
    ? state.operations[request.operationId]
    : undefined;
  if (
    operation?.status === 'ready' &&
    operation.profileId === profileId &&
    operation.pending.callId === request.callId
  ) {
    const accepted = answerGatedCall(
      request,
      {
        name: operation.pending.name,
        arguments: operation.pending.arguments,
        permission: operation.pending.gate.permission,
        gateKind: operation.pending.gate.kind,
        ...(operation.pending.gate.kind === 'auth' && operation.pending.gate.auth
          ? { auth: operation.pending.gate.auth }
          : {}),
      },
      operation.answer.sessionPermissions,
    );
    const { typed: _typed, ...plain } = accepted;
    if (!sameAcceptedAnswer(plain, operation.answer))
      throw new TheoremError('request', labelText('error.request'));
    return {
      callId: request.callId,
      pending: operation.pending,
      answer: { ...operation.answer, ...(accepted.typed ? { typed: accepted.typed } : {}) },
    };
  }
  const pending = Object.hasOwn(state.gates, request.operationId)
    ? state.gates[request.operationId]
    : undefined;
  if (!pending || pending.profileId !== profileId || pending.callId !== request.callId) {
    // labels-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
    throw new TheoremError('request', `gate ${request.callId} is not pending`, {
      copy: { key: 'session.gate_expired' },
    });
  }
  // why: A refused answer (a refused secret, an edit without an approval) throws here and leaves the gate pending.
  const answer = answerGatedCall(
    request,
    {
      name: pending.name,
      arguments: pending.arguments,
      permission: pending.gate.permission,
      gateKind: pending.gate.kind,
      ...(pending.gate.kind === 'auth' && pending.gate.auth ? { auth: pending.gate.auth } : {}),
    },
    state.permissions,
  );
  delete state.gates[request.operationId];
  const { typed: _typed, ...accepted } = answer;
  state.operations[request.operationId] = {
    status: 'ready',
    profileId,
    pending,
    answer: accepted,
    readyAt: Date.now(),
  };
  state.permissions = answer.sessionPermissions;
  return { callId: request.callId, pending, answer };
}

/** A call a message walks away from: taken from its gate now, or settled by an earlier request its client never heard. */
type WalkedCall =
  | AnsweredCall
  | { callId: string; settled: Extract<SessionToolOperation, { status: 'settled' }> };

function walkedCallOf(
  state: TheoremSessionState,
  reference: GateReference,
  profileId: string,
): WalkedCall {
  const settled = Object.hasOwn(state.operations, reference.operationId)
    ? state.operations[reference.operationId]
    : undefined;
  return settled?.status === 'settled' &&
    settled.callId === reference.callId &&
    settled.profileId === profileId
    ? { callId: reference.callId, settled }
    : answerPendingGate(state, { ...reference, decision: 'abandon' }, profileId);
}

/**
 * Take the calls a message or a rewind walks away from out of the session,
 * answered `abandon`: every one of them, or none when one is neither waiting
 * nor settled. Each comes back with the run that settles it.
 */
async function takeWalkedAway(
  ctx: HandlerContext,
  request: Request,
  session: Session,
  abandon: readonly GateReference[],
): Promise<IssuedWalkAway[]> {
  // why: A throw leaves the session unsaved, so no call is taken unless all are.
  const calls = await ctx.sessions.mutate(session.id, (state) =>
    abandon.map((reference) => ({
      reference,
      call: walkedCallOf(state, reference, ctx.profile.id),
    })),
  );
  return calls.map(({ reference, call }) => ({
    ...reference,
    events:
      'settled' in call
        ? replayOperation(ctx, request, call.settled)
        : settleAnswered(ctx, request, session, call),
  }));
}

async function* settleAnswered(
  ctx: HandlerContext,
  request: Request,
  session: Session,
  answered: AnsweredCall,
): AsyncGenerator<TurnEvent> {
  yield* invokeAnswered(ctx, request, session.id, answered);
}

function invokeAnswered(
  ctx: HandlerContext,
  request: Request,
  sessionId: string,
  { callId, pending, answer }: AnsweredCall,
): AsyncGenerator<TurnEvent> {
  return invokeTool({
    profile: ctx.profile.id,
    execution: sessionToolCoordinator(ctx.sessions, sessionId),
    pageExecution: sessionPageDispatch(ctx.sessions, sessionId, ctx.pageToolBroker).execution,
    name: pending.name,
    callId,
    operationId: pending.operationId,
    input: answer.input,
    resume: answer.resume,
    // why: An approval that names no answer is the page saying it has none, so the call is not held again.
    ...(pending.gate.kind === 'page' && answer.resume.granted
      ? { page: answer.page ?? { unanswered: true } }
      : {}),
    sessionPermissions: answer.sessionPermissions,
    credentials: sessionCredentials(ctx, sessionId),
    turnInput: pending.turnInput,
    snapshot: pending.snapshot,
    promoted: pending.promoted,
    model: pending.model,
    signal: request.signal,
    host: ctx.options.host?.(request),
  });
}

/** A settled call's answer, streamed again. */
async function* once(event: TurnEvent, labels?: Profile['labels']): AsyncGenerator<TurnEvent> {
  yield withPublicLabels(event, labels);
}

/** One model run of a chat's reply, its gates recorded in the session as they pause. */
async function* chatTurn(
  ctx: HandlerContext,
  request: Request,
  session: Session,
  turn: ReplyTurn,
  turnId: string | undefined,
): AsyncGenerator<TurnEvent> {
  const state = await ctx.sessions.read(session.id);
  const provider = await providerFor(ctx, request, turn.model);
  const key = turnId ? inboxKey(session.id, turnId) : undefined;
  if (key) await ctx.inbox.open(key);
  try {
    const events = runTurn(
      {
        profile: ctx.profile.id,
        execution: sessionToolCoordinator(ctx.sessions, session.id),
        pageExecution: sessionPageDispatch(ctx.sessions, session.id, ctx.pageToolBroker).execution,
        input: turn.input,
        ...(turn.providerState ? { providerState: turn.providerState } : {}),
        sessionPermissions: state.permissions,
        credentials: sessionCredentials(ctx, session.id),
        signal: request.signal,
        host: ctx.options.host?.(request),
        ...(turn.model ? { model: turn.model } : {}),
        ...(turn.effort ? { effort: turn.effort } : {}),
        ...(key ? { onStage: steerStage(ctx.inbox, key) } : {}),
      },
      provider,
    );
    yield* recorded(
      ctx.sessions,
      session.id,
      withAuthorizationUrls(ctx, request, session.id, events),
      {
        profileId: ctx.profile.id,
        turnInput: turn.input,
        model: turn.model,
      },
    );
  } finally {
    if (key) await ctx.inbox.close(key);
  }
}

/** How this request runs the model for a reply: its generation, and the request's abort. */
function chatRunner(
  ctx: HandlerContext,
  request: Request,
  session: Session,
  generation: { model?: string; effort?: string; turnId?: string },
): ReplyRunner {
  return {
    run: (turn) => chatTurn(ctx, request, session, turn, generation.turnId),
    async compact(history, tokens, model) {
      const provider = await providerFor(ctx, request, model);
      const compacted = await compactHistory(
        {
          profile: ctx.profile.id,
          history,
          tokens,
          signal: request.signal,
          ...(model ? { model } : {}),
        },
        provider,
      );
      return compacted?.history;
    },
    ...(generation.model ? { model: generation.model } : {}),
    ...(generation.effort ? { effort: generation.effort } : {}),
    signal: request.signal,
  };
}

/** The chat's conversation as this session's runs read and write it; undefined when the profile keeps none. */
function conversationHost(ctx: HandlerContext, session: Session): ConversationHost | undefined {
  const store = ctx.chat?.conversations;
  if (!ctx.chat || !store) return undefined;
  const labels = ctx.profile.labels;
  const { clientEvents } = ctx.options;
  return {
    sessionId: session.id,
    store,
    showThoughts: streamThoughtsEnabled(ctx.chat.profile.outputs),
    forReader: (event) => forClient(event, clientEvents),
    failureText(failure) {
      const worded = forClient(withPublicLabels(failure, labels), clientEvents);
      return worded.type === 'error' && worded.error
        ? worded.error
        : labelText(`error.${failure.errorKind}`, {}, labels);
    },
  };
}

/** A file off the wire as the profile's input limits read it. */
function pendingOf(blob: EncodedBlob): PendingAttachment {
  let sizeBytes: number;
  try {
    sizeBytes = base64ToBytes(blob.data).length;
  } catch {
    // invariant: A file that is not base64 is a malformed request; its bytes must not enter diagnostics.
    throw new TheoremError('request', labelText('error.request'), {
      cause: { code: 'request_file_encoding' },
    });
  }
  return { name: blob.name, mimeType: blob.mimeType, sizeBytes, data: blob.data };
}

/** The person's message as the profile accepts it: refused when its files break the profile's limits. */
function postedMessage(iface: ComposerProfileInterface, input: TheoremTurnInput): PostedMessage {
  const prepared = prepareUserTurn(
    iface.inputs,
    {
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.attachments ? { attachments: input.attachments.map(pendingOf) } : {}),
      ...(input.voice ? { voice: input.voice.map(pendingOf) } : {}),
    },
    iface.guardrails,
  );
  if (!prepared.ok) throw attachmentsRefused(prepared.issues);
  return {
    draft: prepared.draft,
    blocks: prepared.blocks,
    media: {
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(input.voice ? { voice: input.voice } : {}),
    },
  };
}

/** The message as the kernel takes it, its text as the transcript shows it. */
function kernelInput(input: TheoremTurnInput, message: PostedMessage, server: unknown): TurnInput {
  const { text: _sent, ...rest } = input;
  return kernelTurnInput(
    message.draft.text === undefined ? rest : { ...rest, text: message.draft.text },
    server,
  );
}

/** Refuses what only a kept conversation answers, for a profile that keeps none. */
function statelessRefusal(what: string): TheoremError {
  // labels-exempt: internal diagnostic; the user reads error.request
  return new TheoremError('request', `a stateless chat keeps no conversation to ${what}`);
}

/** The person's message: a new reply, run against the conversation the host keeps. */
async function turn(
  ctx: HandlerContext,
  chat: ChatContext,
  request: Request,
  session: Session,
): Promise<Response> {
  const body = await readBody(request, theoremTurnRequestSchema, ctx.options.maxRequestBytes);
  const message = postedMessage(chatInterface(chat), body.input);
  const input = kernelInput(body.input, message, await ctx.options.context?.(request));
  const runner = chatRunner(ctx, request, session, body);
  const host = conversationHost(ctx, session);
  if (!host) {
    if (body.conversation !== undefined) throw statelessRefusal('continue');
    // labels-exempt: internal diagnostic; the user reads error.request
    if (body.abandon) throw statelessRefusal('walk away from');
    return eventStream(ctx, request, () =>
      runner.run({ input, model: body.model, effort: body.effort }),
    );
  }
  const opened = await openConversation(host, body.conversation);
  requireWalkAway(opened.conversation, body.abandon);
  // why: Take the walked-away calls before streaming, so a stale one is a reply status, not a stream error.
  const walkAway = body.abandon
    ? await takeWalkedAway(ctx, request, session, body.abandon)
    : undefined;
  return eventStream(ctx, request, () =>
    messageReply({ host, opened, message, input, ...(walkAway ? { walkAway } : {}), runner }),
  );
}

/** The conversation as the browser draws it. */
async function conversation(
  ctx: HandlerContext,
  request: Request,
  session: Session,
): Promise<Response> {
  const body = await readBody(
    request,
    theoremConversationRequestSchema,
    ctx.options.maxRequestBytes,
  );
  const host = conversationHost(ctx, session);
  if (!host) throw statelessRefusal('read');
  const opened = await openConversation(host, body.conversation);
  return jsonResponse(200, conversationView(host, opened.conversation));
}

/** The conversation cut after one block; a reply that waits on gates is walked away from first. */
async function rewind(ctx: HandlerContext, request: Request, session: Session): Promise<Response> {
  const body = await readBody(request, theoremRewindRequestSchema, ctx.options.maxRequestBytes);
  const host = conversationHost(ctx, session);
  if (!host) throw statelessRefusal('rewind');
  const opened = await openConversation(host, body.conversation);
  requireRewindPoint(opened.conversation, body.at);
  const waiting = waitingCalls(opened.conversation).map((call) => ({
    callId: call.callId,
    operationId: requiredOperationId(call),
  }));
  const walkAway = waiting.length
    ? await takeWalkedAway(ctx, request, session, waiting)
    : undefined;
  const next = await rewindConversation({
    host,
    opened,
    at: body.at,
    ...(walkAway ? { walkAway } : {}),
  });
  if (next.ref === null) throw new TheoremError('internal', labelText('error.internal'));
  const rewound: TheoremRewound = {
    conversation: next.ref,
    view: conversationView(host, next.conversation),
  };
  return jsonResponse(200, rewound);
}

async function* invokeEvents(
  ctx: HandlerContext,
  request: Request,
  session: Session,
  answered: AnsweredCall,
): AsyncGenerator<TurnEvent> {
  const { pending, answer } = answered;
  if (answer.typed)
    await saveCredential(ctx, session.id, answer.typed.slot, answer.typed.credential);
  const events = settleAnswered(ctx, request, session, answered);
  yield* recorded(
    ctx.sessions,
    session.id,
    withAuthorizationUrls(ctx, request, session.id, events),
    {
      profileId: ctx.profile.id,
      turnInput: pending.turnInput,
      model: pending.model,
      promoted: pending.promoted,
    },
    [
      {
        type: 'tool',
        tool: {
          name: pending.name,
          callId: pending.callId,
          operationId: pending.operationId,
          arguments: jsonObjectSchema.parse(answer.input),
        },
      },
    ],
  );
}

async function steer(ctx: HandlerContext, request: Request, session: Session): Promise<Response> {
  const body = await readBody(request, theoremSteerRequestSchema, ctx.options.maxRequestBytes);
  if (!(await ctx.inbox.enqueue(inboxKey(session.id, body.turnId), steerUnitOf(body)))) {
    // labels-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
    throw new TheoremError('request', `turn ${body.turnId} is not running`, {
      copy: { key: 'session.turn_ended' },
    });
  }
  return jsonResponse(200, { ok: true });
}

/** One call of one of a host's tools, run as the page asked it; a gate it pauses on waits in the session. */
async function* callEvents(
  ctx: HandlerContext,
  request: Request,
  session: Session,
  body: TheoremHostCallRequest,
): AsyncGenerator<TurnEvent> {
  const state = await ctx.sessions.read(session.id);
  const events = invokeTool({
    profile: ctx.profile.id,
    execution: sessionToolCoordinator(ctx.sessions, session.id),
    pageExecution: sessionPageDispatch(ctx.sessions, session.id, ctx.pageToolBroker).execution,
    name: body.name,
    input: body.input,
    sessionPermissions: state.permissions,
    credentials: sessionCredentials(ctx, session.id),
    signal: request.signal,
    host: ctx.options.host?.(request),
  });
  yield* recorded(
    ctx.sessions,
    session.id,
    withAuthorizationUrls(ctx, request, session.id, events),
    {
      profileId: ctx.profile.id,
      turnInput: {},
    },
  );
}

function answerRequest(body: TheoremInvokeRequest): GateAnswerRequest & GateReference {
  return {
    callId: body.gateId,
    operationId: body.operationId,
    decision: body.decision,
    input: body.input,
    secret: body.secret,
    page: body.page,
  };
}

/** A route this profile doesn't serve. */
function refused(ctx: HandlerContext): Response {
  return jsonResponse(HTTP_METHOD, {
    error: labelText('error.request', {}, ctx.profile.labels),
    errorKind: 'request',
  });
}

async function* replayOperation(
  ctx: HandlerContext,
  request: Request,
  operation: Extract<SessionToolOperation, { status: 'settled' }>,
): AsyncGenerator<TurnEvent> {
  const tool = defaultKernelScope.tools.get(operation.toolId);
  if (
    operation.profileId !== ctx.profile.id ||
    !tool ||
    tool.type === 'builtin' ||
    !('tools' in ctx.profile) ||
    !ctx.profile.tools?.allow.includes(operation.toolId) ||
    (ctx.options.authorizeToolReplay &&
      !(await ctx.options.authorizeToolReplay({ request, operation })))
  )
    throw new TheoremError('blocked', labelText('error.blocked'));
  authorizeToolReplay({
    tools: defaultKernelScope.tools,
    profile: ctx.profile,
    name: operation.toolId,
    resume: undefined,
    outcome: operation.outcome,
  });
  yield* once(operation.outcome.event, ctx.profile.labels);
}

/**
 * The user's answer to a paused call. In a kept conversation the reply goes on
 * in the same stream once no call waits; otherwise the stream is the call's.
 */
async function invoke(ctx: HandlerContext, request: Request, session: Session): Promise<Response> {
  const body = await readBody(request, theoremInvokeRequestSchema, ctx.options.maxRequestBytes);
  if (body.page && 'output' in body.page)
    throw new TheoremError('request', labelText('error.request'));
  const host = conversationHost(ctx, session);
  if (!host) {
    if (body.conversation !== undefined) throw statelessRefusal('continue');
    return eventStream(ctx, request, await settlingOf(ctx, request, session, body));
  }
  if (body.conversation === undefined) throw unknownConversation();
  const opened = await openConversation(host, body.conversation);
  const call = { callId: body.gateId, operationId: body.operationId };
  requireWaitingOn(opened.conversation, call);
  const settling = await settlingOf(ctx, request, session, body);
  const runner = chatRunner(ctx, request, session, body);
  return eventStream(ctx, request, () =>
    answerReply({ host, opened, call, settling: settling(), runner }),
  );
}

/** The answered call's events: its saved outcome again, or the call run as answered. */
async function settlingOf(
  ctx: HandlerContext,
  request: Request,
  session: Session,
  body: TheoremInvokeRequest,
): Promise<() => AsyncIterable<TurnEvent>> {
  const saved = await ctx.sessions.read(session.id);
  const operation = Object.hasOwn(saved.operations, body.operationId)
    ? saved.operations[body.operationId]
    : undefined;
  if (
    operation &&
    operation.status !== 'ready' &&
    operation.callId === body.gateId &&
    operation.profileId === ctx.profile.id &&
    (operation.status === 'running' || operation.status === 'uncertain')
  ) {
    throw new TheoremError('unavailable', labelText('tool.execution_uncertain'), {
      copy: { key: 'tool.execution_uncertain' },
    });
  }
  if (
    operation?.status === 'settled' &&
    operation.profileId === ctx.profile.id &&
    operation.callId === body.gateId
  ) {
    if (
      body.input !== undefined &&
      (!operation.invocation ||
        (await toolInvocationHash(body.input)) !==
          (await toolInvocationHash(operation.invocation.accepted.input)))
    )
      throw new TheoremError('request', labelText('error.request'), {
        copy: { key: 'error.request' },
      });
    return () => replayOperation(ctx, request, operation);
  }
  // why: Take the answered call before streaming, so a stale answer is a reply status, not a stream error.
  const answered = await ctx.sessions.mutate(session.id, (state) =>
    answerPendingGate(state, answerRequest(body), ctx.profile.id),
  );
  return () => invokeEvents(ctx, request, session, answered);
}

async function hostRoute(
  ctx: HandlerContext & { profile: Extract<Profile, { type: 'host' }> },
  request: Request,
  session: Session,
): Promise<Response> {
  const target = routeOf(request);
  if (request.method === 'GET' && target === '') {
    const tool = (name: string) => {
      const registered = defaultKernelScope.tools.get(name);
      return registered?.type === 'builtin' ? undefined : registered;
    };
    return jsonResponse(200, { interface: hostInterface(ctx.profile, tool) });
  }
  if (request.method === 'POST' && target === 'call') {
    const body = await readBody(request, theoremHostCallRequestSchema, ctx.options.maxRequestBytes);
    return eventStream(ctx, request, () => callEvents(ctx, request, session, body));
  }
  if (request.method === 'POST' && target === 'invoke') return invoke(ctx, request, session);
  return refused(ctx);
}

async function route(ctx: HandlerContext, request: Request, session: Session): Promise<Response> {
  if (request.method === 'POST' && routeOf(request) === 'page-result') {
    const body = await readBody(request, pageToolResultSchema, ctx.options.maxRequestBytes);
    await sessionPageDispatch(ctx.sessions, session.id, ctx.pageToolBroker).answer(body);
    return jsonResponse(200, { accepted: true });
  }
  if (ctx.profile.type === 'host')
    return hostRoute({ ...ctx, profile: ctx.profile }, request, session);
  const { chat } = ctx;
  const target = routeOf(request);
  if (!chat) return refused(ctx);
  if (request.method === 'GET' && target === '')
    return jsonResponse(200, {
      interface: clientProfileInterface(chat.profile, defaultKernelScope.tools),
    });
  if (request.method !== 'POST' || target === '' || target === 'call') return refused(ctx);
  if (target === 'turn') return turn(ctx, chat, request, session);
  if (target === 'invoke') return invoke(ctx, request, session);
  if (target === 'conversation') return conversation(ctx, request, session);
  if (target === 'rewind') return rewind(ctx, request, session);
  return steer(ctx, request, session);
}

export function createTheoremHandler(
  options: TheoremHandlerOptions,
): (request: Request) => Promise<Response> {
  const profile = defineProfile(options.profile as ProfileDefinition);
  if (profile.type === 'decision') {
    // labels-exempt: builder config error at setup; no user sees it
    throw new Error(
      "createTheoremHandler serves turn-based profiles; serve type 'decision' with createTheoremDecisionHandler.",
    );
  }
  if (profile.type === 'host') {
    // labels-exempt: builder config error at setup; no user sees it
    throw new Error(
      "createTheoremHandler serves turn-based profiles; serve type 'host' with createTheoremHostHandler.",
    );
  }
  if (profile.type === 'live') {
    // labels-exempt: builder config error at setup; no user sees it
    throw new Error(`createTheoremHandler serves turn-based profiles; got type '${profile.type}'.`);
  }
  const stateless = profile.providerContinuation?.history === 'stateless';
  if (stateless === (options.conversationStore !== undefined)) {
    throw new TheoremError('config', labelText('error.config'), {
      cause: {
        code: stateless ? 'conversation_store_stateless' : 'conversation_store_missing',
        profile: profile.id,
      },
    });
  }
  return serve('createTheoremHandler', profile, options, {
    steerInbox: options.steerInbox,
    chat: {
      profile,
      ...(options.conversationStore ? { conversations: options.conversationStore } : {}),
    },
  });
}

/**
 * Serves a host profile to `<TheoremHost />`: the page calls the profile's tools
 * directly, and every call runs through the kernel's gates and guardrails.
 */
export function createTheoremHostHandler(
  options: TheoremHostHandlerOptions,
): (request: Request) => Promise<Response> {
  const profile = defineProfile(options.profile as ProfileDefinition);
  if (profile.type !== 'host') {
    // labels-exempt: builder config error at setup; no user sees it
    throw new Error(`createTheoremHostHandler serves type 'host'; got type '${profile.type}'.`);
  }
  return serve('createTheoremHostHandler', profile, options);
}

function serve(
  name: string,
  profile: Profile,
  options: HandlerContext['options'],
  chatOptions: { steerInbox?: SteerInbox; chat?: ChatContext } = {},
): (request: Request) => Promise<Response> {
  const gateTtlMs = resolveGateTtlMs(name, options.gateTtlMs);
  const operationRetentionMs = options.operationRetentionMs ?? DEFAULT_OPERATION_RETENTION_MS;
  if (!Number.isSafeInteger(operationRetentionMs) || operationRetentionMs <= 0) {
    throw new TheoremError('config', labelText('error.config'), {
      cause: { code: 'operation_retention' },
    });
  }
  const limits = resolveSessionLimits(options.sessionLimits);
  requestByteLimit(options.maxRequestBytes);
  registerProfile(profile);
  const ctx: HandlerContext = {
    options,
    pageToolBroker: options.pageToolBroker ?? createMemoryPageToolBroker(),
    profile,
    ...(chatOptions.chat ? { chat: chatOptions.chat } : {}),
    inbox: chatOptions.steerInbox ?? createMemorySteerInbox(),
    sessions: sessionStateStore(
      options.sessionStore ?? createMemorySessionStore({ sessionLimits: limits }),
      gateTtlMs,
      operationRetentionMs,
      limits,
    ),
    credentials: lockedStore(
      options.credentialStore ?? createMemoryCredentialStore(),
      (saved = {}) => saved,
    ),
  };

  return async (request) => {
    let session: Session | undefined;
    try {
      session = await sessionOf(ctx, request);
      return withSessionCookie(await route(ctx, request, session), session);
    } catch (err) {
      return withSessionCookie(
        jsonResponse(caughtStatus(err), caughtError(ctx, err, request)),
        session,
      );
    }
  };
}
