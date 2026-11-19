import { type PageToolBroker, pageToolResultSchema, sessionPageDispatch } from './page-dispatch.ts';
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
 * - `POST <base>/stop`    → stop a running turn where it stands
 * - `POST <base>/page-result` → the page's result for a tool the turn ran in the page
 * - `POST <base>/conversation` → the transcript and the paused reply, to draw
 * - `POST <base>/notify`  → NDJSON that stays open: one line now, and one for each `publish` under
 *                            this session: a background call ended, or the app saved a reply.
 *                            Set `notifier` to serve it
 * - `POST <base>/rewind`  → `{ conversation, view }` the conversation cut after one block, and its new ref
 * - `POST <base>/wake`    → NDJSON for a reply to no message: the model takes up the results of
 *                            background calls that ended since it last ran. Empty when none waits
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
  defaultKernelScope,
  defineProfile,
  labelText,
  type Profile,
  type ProfileDefinition,
  type ProviderHostOptions,
  type StageHandler,
  TheoremError,
  type ToolGate,
  type TurnWiring,
  type z,
} from '@theoremjs/agents';
import type { InboxItem } from '@theoremjs/agents/conversation';
import {
  type ClientError,
  type ClientTurnOptions,
  caughtStatus,
  clientError,
  forClient,
  HTTP_NOT_FOUND,
} from '@theoremjs/agents/host';
import { clientProfileInterface, type TranscriptBlock } from '@theoremjs/agents/interface';
import type { ToolBackgroundService } from '@theoremjs/agents/kernel';
import { hostInterface, theoremHostCallRequestSchema } from '../client/host-transport.ts';
import {
  type ConversationLine,
  type TheoremSavedMessage,
  type TheoremTurnInput,
  theoremConversationRequestSchema,
  theoremInvokeRequestSchema,
  theoremNotifyRequestSchema,
  theoremRewindRequestSchema,
  theoremSteerRequestSchema,
  theoremStopRequestSchema,
  theoremTurnRequestSchema,
  theoremWakeRequestSchema,
} from '../client/transport.ts';
import { type ReplyLine, statelessRefusal } from './conversation.ts';
import {
  type ChatContext,
  type ConversationCore,
  type CoreState,
  chatOf,
  createConversationCore,
  followedUp,
  type MessageArgs,
  oneInbox,
  type Reply,
  type ReplyWiring,
  unconversedAnswer,
} from './conversation-core.ts';
import type { TheoremConversationStore } from './conversation-store.ts';
import type { TheoremCredentialStore, TheoremCredentials } from './credential-store.ts';
import type { TheoremNotifier } from './notifier.ts';
import type { MutableStore, SessionStateStore } from './session-authority.ts';
import { type CallsContext, type CoreContext, callEvents, sessionParts } from './session-calls.ts';
import { type Session, theoremSession } from './session-identity.ts';
import { kernelTurnInput } from './turn-input.ts';
import type { AppPrepare } from './turn-wiring.ts';

export { theoremSession, theoremSessionId } from './session-identity.ts';

import { jsonResponse } from './json-response.ts';
import { boundedRequestJson, requestByteLimit } from './request-body.ts';
import { checkRequest } from './request-check.ts';
import type { SessionToolOperation, TheoremSessionStore } from './session-store.ts';
import { createMemorySteerInbox, type SteerInbox, steerUnitOf } from './steer-inbox.ts';

export type TheoremRequestContext = {
  request: Request;
  /** Selected model id, when the client picked one. */
  model?: string;
};

/**
 * Options for `createTheoremHandler`. The app's own parts of a reply (`prepare`, `inbox`,
 * `beforeSave`, `afterSave`, `compact`) are the conversation core's, and take the request's
 * `CoreContext`: its `host` is what the `host` option returned for the request, asked once.
 */
export type TheoremHandlerOptions<Item extends InboxItem = InboxItem> = ReplyWiring<Item> & {
  /** Profile to serve. Registered with the kernel when the handler is created. */
  profile: Profile | ProfileDefinition;
  /**
   * Host options for registered providers, or a factory for hosts that
   * pick keys per request (BYOK, tenant vaults). Tools are registered by the host.
   */
  provider:
    | ProviderHostOptions
    | ((ctx: TheoremRequestContext) => ProviderHostOptions | Promise<ProviderHostOptions>);
  /**
   * Opaque app context for tool handlers (`ctx.host`) — e.g. the signed-in user. A promise is
   * awaited before the run starts, so the tools read what it settles to.
   */
  host?: (request: Request) => unknown;
  /**
   * What the host wants the agent to know on each turn: any JSON. The profile's
   * `inputs.context.from` must list `server`. The page's own context arrives in the
   * request and is read as untrusted; this one is the host's.
   */
  context?: (request: Request) => unknown;
  /**
   * Let the page say which prompt lines a turn gets (`stated`), for a page the host trusts as it
   * trusts itself: the studio's. Unset refuses them, so a public page never chooses its own lines.
   */
  pageStatesTurn?: boolean;
  /**
   * The server's own stage handler, on every call this handler runs, a host's included: after
   * the application's, before steering. For a rule the server adds to whatever the application
   * says, such as a question before each tool that writes.
   */
  onStage?: StageHandler;
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
   * milliseconds. An answer after that is refused with `session.gate_expired`,
   * and the next message cancels the call. Unset, a gate waits until it is answered.
   */
  gateTtlMs?: number;
  /** Retain settled tool results in milliseconds. Default: 24 hours. */
  operationRetentionMs?: number;
  /** Maximum UTF-8 request body bytes before JSON parsing. Unset, a body of any size is read. */
  maxRequestBytes?: number;
  pageToolBroker?: PageToolBroker;
  /**
   * How long the page has to answer a tool call it runs, in milliseconds. A call it has not
   * answered by then settles as timed out. Unset, it waits until the page answers or the turn stops.
   */
  pageToolTimeoutMs?: number;
  /**
   * The service for tools with a `background` setting, by session. It receives each detached call
   * and its late events. The session keeps each call's state and result. A `background` that
   * `prepare` returns runs in its place. Unset, and with none from `prepare`, every tool runs
   * inline. The value must stay valid after the request ends, until each call settles.
   */
  background?: (ctx: { request: Request; sessionId: string }) => ToolBackgroundService;
  /**
   * Tells an open page that a background call ended, so it redraws with no turn or reload. Unset,
   * the page reads the end on its next turn or reload. A sweep that marks a call itself calls
   * `publish` too. With `inbox`, the page always listens, and the app calls `publish` for each
   * reply it saves away from the page. `createMemoryNotifier` for one instance.
   */
  notifier?: TheoremNotifier;
  /**
   * How long an open page waits to reopen `notifier`'s stream after it ends, in milliseconds.
   * Hosting platforms cut long responses. Unset, the page does not reopen it.
   */
  notifyRetryMs?: number;
  /** Check current resource access before disclosing a saved tool result. This callback must be read-only. */
  authorizeToolReplay?: (context: {
    request: Request;
    operation: Extract<SessionToolOperation, { status: 'settled' }>;
  }) => boolean | Promise<boolean>;
  /**
   * Who tells the model that a background call ended: `TurnWiring.lateResultsDecider`. Unset, no
   * page wakes the chat and no reply reads a late result. `tellEveryResult` tells each result to
   * the first reply that runs, and lets the open page wake the chat.
   */
  lateResultsDecider?: TurnWiring['lateResultsDecider'];
  /**
   * How long a reply keeps its chat after it last renewed, in milliseconds: it renews every third
   * of it while it runs. A wake the chat turned away tries again once this runs out, and a reply
   * that stopped without letting go keeps the chat no longer. Default 60000.
   */
  conversationLeaseMs?: number;
  /**
   * Who runs the next reply when a reply ends with items that wait and may be told now. `here`:
   * the handler runs it in the same response. `taken`: your app runs it, by its own call to the
   * conversation core's `followUp`. Unset, the handler lets the chat go, and the page wakes it.
   */
  onContinue?: (
    run: { ref: string; hold: string },
    at: { request: Request; sessionId: string },
  ) => 'here' | 'taken' | Promise<'here' | 'taken'>;
  /**
   * Your app's own save of a person's message, for `/turn` and `/steer`. It saves the message
   * under `sent.id` one time, and in the same write takes the conversation in your `inbox` when
   * no reply holds it. `sent.ref` is the page's ref of the conversation, when it has one. Needs
   * `inbox`. With it, a steer does not go to `steerInbox`.
   */
  intake?: (
    at: CoreContext,
    sent: { id: string; ref?: string; message: TheoremTurnInput },
  ) => Promise<MessageIntake>;
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

/**
 * What `intake` did with a person's message. `ref` is the conversation that now holds it.
 * `landsAs` is each id a reply names the message by when it reads it: the id of its inject on a
 * `stage` line, the id of its inbox item, and the id of each of its blocks in the conversation.
 *
 * - `opened`: the save took the conversation under `hold`. The handler runs the reply, and
 *   `blocks` is the message as the app saved it.
 * - `saved`: no reply runs for this request. Another reply holds the conversation and reads the
 *   message, or the app saved this id before, or the app answered the message with a line of its
 *   own.
 */
export type MessageIntake =
  | {
      outcome: 'opened';
      ref: string;
      landsAs: readonly string[];
      hold: string;
      blocks: readonly TranscriptBlock[];
    }
  | { outcome: 'saved'; ref: string; landsAs: readonly string[] };

/** A host profile runs no model, and takes no turns to steer. */
export type TheoremHostHandlerOptions = Omit<
  TheoremHandlerOptions,
  | 'profile'
  | 'provider'
  | 'steerInbox'
  | 'conversationStore'
  | 'prepare'
  | 'inbox'
  | 'beforeSave'
  | 'afterSave'
  | 'compact'
  | 'notifier'
  | 'notifyRetryMs'
  | 'conversationLeaseMs'
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
    last === 'stop' ||
    last === 'conversation' ||
    last === 'notify' ||
    last === 'rewind' ||
    last === 'wake' ||
    last === 'call' ||
    last === 'page-result'
    ? last
    : '';
}

/** Everything a request needs from the handler that serves it. */
type HandlerContext = {
  /** A host's handler has no provider: it runs no model. */
  options: Omit<TheoremHandlerOptions, 'profile' | 'provider' | keyof ReplyWiring> &
    Partial<Pick<TheoremHandlerOptions, 'provider'>> & {
      /** The app's turn for a call that no reply runs: an answered call, a host's call. */
      prepare?: AppPrepare;
    };
  profile: Profile;
  /** A chat's: none for a host profile, which takes no messages. */
  chat?: ChatContext;
  /** The conversation core over a request's state, with the app's own parts of a reply. */
  wire: (state: CoreState) => ConversationCore;
  inbox: SteerInbox;
  sessions: SessionStateStore;
  pageToolBroker: PageToolBroker;
  credentials: MutableStore<TheoremCredentials>;
};

async function sessionOf(ctx: HandlerContext, request: Request): Promise<Session> {
  if (!ctx.options.session) return theoremSession(request);
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

/** What a run reads in place of `request`. */
function contextOf(ctx: HandlerContext, request: Request, sessionId: string): CoreContext {
  let asked: { host: unknown } | undefined;
  return {
    sessionId,
    signal: request.signal,
    // why: The app's `host` is asked when a run first reads it, so a route that reads none asks
    // none, and a reply and the app's steps around its save read the same value.
    get host() {
      asked ??= { host: ctx.options.host?.(request) };
      return asked.host;
    },
  };
}

/** The session's calls as `request` runs them: each of the app's callbacks is given `request`. */
function callsOf(ctx: HandlerContext, request: Request): CallsContext {
  const { options } = ctx;
  const { background, authorizeToolReplay, authorizationUrl } = options;
  return {
    profile: ctx.profile,
    sessions: ctx.sessions,
    credentials: ctx.credentials,
    pageToolBroker: ctx.pageToolBroker,
    options: {
      prepare: options.prepare,
      onStage: options.onStage,
      pageToolTimeoutMs: options.pageToolTimeoutMs,
      notifier: options.notifier,
      lateResultsDecider: options.lateResultsDecider,
      ...(background
        ? { background: (at) => background({ request, sessionId: at.sessionId }) }
        : {}),
      ...(authorizeToolReplay
        ? { authorizeToolReplay: (_at, operation) => authorizeToolReplay({ request, operation }) }
        : {}),
      ...(authorizationUrl
        ? {
            authorizationUrl: (challenge, at) =>
              authorizationUrl(challenge, { request, sessionId: at.sessionId }),
          }
        : {}),
      onError: (err) => options.onError?.(err, { request }),
      wake: (at, ref) => serverWake(ctx, request, at.sessionId, ref),
    },
  };
}

/** The chat's conversation core as `request` runs it. */
function coreOf(ctx: HandlerContext, chat: ChatContext, request: Request): ConversationCore {
  const calls = callsOf(ctx, request);
  return ctx.wire({
    ...calls,
    chat,
    steer: ctx.inbox,
    options: {
      ...calls.options,
      provider: (_at, model) => providerFor(ctx, request, model),
      conversationLeaseMs: ctx.options.conversationLeaseMs,
      notifyRetryMs: ctx.options.notifyRetryMs,
      clientEvents: ctx.options.clientEvents,
    },
  });
}

/**
 * A page's run: when it ends with items that wait, `onContinue` says who runs the next reply.
 * Unset, the chat is let go, and the page wakes it.
 */
function pageRun(
  ctx: HandlerContext,
  request: Request,
  core: ConversationCore,
  at: CoreContext,
  reply: Reply,
): Reply {
  const { onContinue } = ctx.options;
  return followedUp(core, at, reply, (run) =>
    onContinue ? onContinue(run, { request, sessionId: at.sessionId }) : 'let_go',
  );
}

/**
 * The decider's wake, with no page: the reply runs on a request of its own, with the headers of
 * the one that started the call and no signal, because that request has ended. When another reply
 * holds the chat, it tries again as that hold's lease runs out.
 */
async function serverWake(
  ctx: HandlerContext,
  started: Request,
  sessionId: string,
  ref: string,
): Promise<void> {
  const request = new Request(started.url, { headers: started.headers });
  if (!ctx.chat) throw statelessRefusal('wake');
  const core = coreOf(ctx, ctx.chat, request);
  const at = contextOf(ctx, request, sessionId);
  // why: no page is open to wake the chat, so this wake runs each next reply itself
  const lines = followedUp(core, at, await core.wake(at, { ref }), () => 'here');
  // why: the run lets the chat go as it ends, so its lines are read to the end before a failure is thrown
  let failed: TheoremError | undefined;
  for (;;) {
    const next = await lines.next();
    if (next.done) {
      if (failed) throw failed;
      if (next.value.outcome !== 'held') return;
      setTimeout(
        () => {
          serverWake(ctx, started, sessionId, ref).catch((err: unknown) =>
            ctx.options.onError?.(err, { request }),
          );
        },
        Math.max(0, next.value.leasedUntil - Date.now()),
      );
      return;
    }
    if (next.value.type === 'error') {
      // labels-exempt: internal diagnostic for the decider's wake; no page reads it
      failed ??= new TheoremError(
        next.value.errorKind,
        next.value.errorInternal ?? next.value.error ?? 'the wake failed',
      );
    }
  }
}

/** The person's message: a new reply, run against the conversation the host keeps. */
async function turn(
  ctx: HandlerContext,
  chat: ChatContext,
  request: Request,
  session: Session,
): Promise<Response> {
  const body = await readBody(request, theoremTurnRequestSchema, ctx.options.maxRequestBytes);
  if (body.stated && !ctx.options.pageStatesTurn) {
    throw new TheoremError('request', labelText('error.request'));
  }
  const context = await ctx.options.context?.(request);
  const core = coreOf(ctx, chat, request);
  const at = contextOf(ctx, request, session.id);
  const message: MessageArgs = {
    ref: body.conversation,
    input: body.input,
    ...(context === undefined ? {} : { context }),
    generation: body,
    ...(body.abandon ? { abandon: body.abandon } : {}),
  };
  if (ctx.options.intake) {
    if (body.id === undefined) {
      // labels-exempt: internal diagnostic; the user reads error.request
      throw new TheoremError('request', 'a message needs an `id` where the host saves it itself');
    }
    const taken = await savedMessage(ctx.options.intake, core, at, { id: body.id, message });
    return eventStream(ctx, request, () =>
      taken.outcome === 'saved'
        ? lines([savedLine(taken)])
        : openedRun(ctx, request, core, at, taken, message),
    );
  }
  const reply = await core.message(at, message);
  return eventStream(ctx, request, () => pageRun(ctx, request, core, at, reply));
}

/**
 * The app's save of a message, after the checks that can refuse it.
 * invariant: Nothing refuses a message the app has saved, so the page never takes a saved message back.
 */
async function savedMessage(
  intake: NonNullable<TheoremHandlerOptions['intake']>,
  core: ConversationCore,
  at: CoreContext,
  sent: { id: string; message: Pick<MessageArgs, 'ref' | 'input' | 'context' | 'abandon'> },
): Promise<MessageIntake> {
  await core.checkMessage(at, sent.message);
  const { ref, input } = sent.message;
  return intake(at, { id: sent.id, ...(ref === undefined ? {} : { ref }), message: input });
}

/** The line that tells the page the app saved its message, and how a reply names it. */
function savedLine(taken: MessageIntake): ConversationLine {
  return { type: 'conversation', ref: taken.ref, posted: true, landsAs: [...taken.landsAs] };
}

async function* lines(values: readonly ReplyLine[]): AsyncGenerator<ReplyLine> {
  yield* values;
}

/**
 * The reply to a message whose save took the conversation. The saved line goes first: whatever
 * the reply does after it, the message stays saved.
 */
async function* openedRun(
  ctx: HandlerContext,
  request: Request,
  core: ConversationCore,
  at: CoreContext,
  taken: Extract<MessageIntake, { outcome: 'opened' }>,
  message: MessageArgs,
): AsyncGenerator<ReplyLine> {
  const { ref, hold, blocks } = taken;
  yield savedLine(taken);
  let reply: Reply;
  try {
    reply = await core.message(at, { ...message, ref, saved: { hold, blocks } });
  } catch (err) {
    // why: No reply took the hold, so the handler lets the conversation go for the next one.
    await core.release(at, { ref, hold });
    throw err;
  }
  yield* pageRun(ctx, request, core, at, reply);
}

/** The conversation as the browser draws it. */
async function conversation(
  ctx: HandlerContext,
  chat: ChatContext,
  request: Request,
  session: Session,
): Promise<Response> {
  const body = await readBody(
    request,
    theoremConversationRequestSchema,
    ctx.options.maxRequestBytes,
  );
  const view = await coreOf(ctx, chat, request).read(contextOf(ctx, request, session.id), {
    ref: body.conversation,
  });
  return jsonResponse(200, view);
}

/**
 * A reply to no message, for results that ended since the model last ran. It runs under a hold of
 * the chat, so two pages that wake at once run it once, and reads what the decider's policy tells.
 */
async function wake(
  ctx: HandlerContext,
  chat: ChatContext,
  request: Request,
  session: Session,
): Promise<Response> {
  const body = await readBody(request, theoremWakeRequestSchema, ctx.options.maxRequestBytes);
  const input = kernelTurnInput(body.input ?? {}, await ctx.options.context?.(request));
  const core = coreOf(ctx, chat, request);
  const at = contextOf(ctx, request, session.id);
  const reply = await core.wake(at, { ref: body.conversation, generation: body, input });
  return eventStream(ctx, request, () => pageRun(ctx, request, core, at, reply));
}

const CHANGED_LINE = new TextEncoder().encode('{"type":"changed"}\n');

/**
 * One line now, then one for each background call that ends. The stream names no conversation,
 * because a store's ref can change with each write; the page reads under the ref it holds.
 * invariant: The first line follows the subscribe, so a call that ends before the page's first
 * read is never missed.
 */
async function notify(
  ctx: HandlerContext,
  request: Request,
  session: Session,
  notifier: TheoremNotifier,
): Promise<Response> {
  await readBody(request, theoremNotifyRequestSchema, ctx.options.maxRequestBytes);
  let send = () => {};
  const unsubscribe = await notifier.subscribe(session.id, () => send());
  let open = true;
  const end = () => {
    if (!open) return;
    open = false;
    unsubscribe();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      send = () => {
        if (open) controller.enqueue(CHANGED_LINE);
      };
      send();
      const leave = () => {
        if (!open) return;
        end();
        controller.close();
      };
      if (request.signal.aborted) leave();
      else request.signal.addEventListener('abort', leave, { once: true });
    },
    cancel: end,
  });
  return new Response(stream, { headers: NDJSON_HEADERS });
}

/** The conversation cut after one block; a reply that waits on gates is walked away from first. */
async function rewind(
  ctx: HandlerContext,
  chat: ChatContext,
  request: Request,
  session: Session,
): Promise<Response> {
  const body = await readBody(request, theoremRewindRequestSchema, ctx.options.maxRequestBytes);
  const rewound = await coreOf(ctx, chat, request).rewind(contextOf(ctx, request, session.id), {
    ref: body.conversation,
    at: body.at,
  });
  return jsonResponse(200, rewound);
}

async function steer(
  ctx: HandlerContext,
  chat: ChatContext,
  request: Request,
  session: Session,
): Promise<Response> {
  const body = await readBody(request, theoremSteerRequestSchema, ctx.options.maxRequestBytes);
  const core = coreOf(ctx, chat, request);
  const at = contextOf(ctx, request, session.id);
  if (ctx.options.intake) {
    const message = {
      ...(body.conversation === undefined ? {} : { ref: body.conversation }),
      input: body.input,
    };
    const taken = await savedMessage(ctx.options.intake, core, at, { id: body.id, message });
    if (taken.outcome === 'opened') {
      const run = { ref: taken.ref, hold: taken.hold };
      const { onContinue } = ctx.options;
      const who = onContinue
        ? await onContinue(run, { request, sessionId: at.sessionId })
        : 'let_go';
      // why: A steer has no stream for a reply, so `here` is the page's own wake.
      if (who !== 'taken') await core.release(at, run);
    }
    const saved: TheoremSavedMessage = { conversation: taken.ref, landsAs: [...taken.landsAs] };
    return jsonResponse(200, { ok: true, saved });
  }
  core.checkSteer(body.input);
  if (!(await core.steer(at, { turnId: body.turnId, unit: steerUnitOf(body) }))) {
    // labels-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
    throw new TheoremError('request', `turn ${body.turnId} is not running`, {
      copy: { key: 'session.turn_ended' },
    });
  }
  return jsonResponse(200, { ok: true });
}

/** Stops a running turn where it stands; its stream goes on to save and send what the reply left. */
async function stop(
  ctx: HandlerContext,
  chat: ChatContext,
  request: Request,
  session: Session,
): Promise<Response> {
  const body = await readBody(request, theoremStopRequestSchema, ctx.options.maxRequestBytes);
  const core = coreOf(ctx, chat, request);
  if (!(await core.stop(contextOf(ctx, request, session.id), { turnId: body.turnId }))) {
    // labels-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
    throw new TheoremError('request', `turn ${body.turnId} is not running`, {
      copy: { key: 'session.turn_ended' },
    });
  }
  return jsonResponse(200, { ok: true });
}

/** A route this profile doesn't serve. */
function refused(ctx: HandlerContext): Response {
  return jsonResponse(HTTP_NOT_FOUND, {
    error: labelText('error.not_found', {}, ctx.profile.labels),
    errorKind: 'not_found',
  });
}

/**
 * The user's answer to a paused call. In a kept conversation the reply goes on
 * in the same stream once no call waits; otherwise the stream is the call's.
 */
async function invoke(ctx: HandlerContext, request: Request, session: Session): Promise<Response> {
  const body = await readBody(request, theoremInvokeRequestSchema, ctx.options.maxRequestBytes);
  if (body.page && 'output' in body.page)
    throw new TheoremError('request', labelText('error.request'));
  const at = contextOf(ctx, request, session.id);
  if (!ctx.chat) {
    const lines = await unconversedAnswer(callsOf(ctx, request), at, body);
    return eventStream(ctx, request, () => lines);
  }
  const core = coreOf(ctx, ctx.chat, request);
  const reply = await core.answer(at, body);
  return eventStream(ctx, request, () => pageRun(ctx, request, core, at, reply));
}

async function hostRoute(
  ctx: HandlerContext & { profile: Extract<Profile, { type: 'host' }> },
  request: Request,
  session: Session,
): Promise<Response> {
  const target = routeOf(request);
  if (request.method === 'GET' && target === '')
    return jsonResponse(200, { interface: hostInterface(ctx.profile, hostTool) });
  if (request.method === 'POST' && target === 'call') {
    const body = await readBody(request, theoremHostCallRequestSchema, ctx.options.maxRequestBytes);
    return eventStream(ctx, request, () =>
      callEvents(callsOf(ctx, request), contextOf(ctx, request, session.id), body),
    );
  }
  if (request.method === 'POST' && target === 'invoke') return invoke(ctx, request, session);
  return refused(ctx);
}

async function route(ctx: HandlerContext, request: Request, session: Session): Promise<Response> {
  if (request.method === 'POST' && routeOf(request) === 'page-result') {
    const body = await readBody(request, pageToolResultSchema, ctx.options.maxRequestBytes);
    await sessionPageDispatch(
      ctx.sessions,
      session.id,
      ctx.pageToolBroker,
      ctx.options.pageToolTimeoutMs,
    ).answer(body);
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
  if (target === 'conversation') return conversation(ctx, chat, request, session);
  if (target === 'notify') {
    const { notifier } = ctx.options;
    if (!notifier || !chat.conversations) return refused(ctx);
    return notify(ctx, request, session, notifier);
  }
  if (target === 'rewind') return rewind(ctx, chat, request, session);
  if (target === 'wake') return wake(ctx, chat, request, session);
  if (target === 'stop') return stop(ctx, chat, request, session);
  return steer(ctx, chat, request, session);
}

export function createTheoremHandler<Item extends InboxItem = InboxItem>(
  options: TheoremHandlerOptions<Item>,
): (request: Request) => Promise<Response> {
  const chat = chatOf('createTheoremHandler', options.profile, options.conversationStore);
  oneInbox(options);
  if (options.intake && !options.inbox) {
    // labels-exempt: builder config error at setup; no user sees it
    throw new TheoremError('config', 'createTheoremHandler needs `inbox` with `intake`');
  }
  const { prepare, inbox, beforeSave, afterSave, compact } = options;
  return serve('createTheoremHandler', chat.profile, options, {
    steerInbox: options.steerInbox,
    chat,
    wire: (state) =>
      createConversationCore<Item>({
        ...state,
        options: { ...state.options, prepare, inbox, beforeSave, afterSave, compact },
      }),
  });
}

/**
 * Serves a host profile to `<TheoremHost />`: the page calls the profile's tools
 * directly, and every call runs through the kernel's gates and guardrails.
 */
export function createTheoremHostHandler(
  options: TheoremHostHandlerOptions,
): (request: Request) => Promise<Response> {
  return serve(
    'createTheoremHostHandler',
    defineHostProfile('createTheoremHostHandler', options.profile),
    options,
  );
}

/** The host profile a handler serves; any other type is the builder's mistake, refused at setup. */
export function defineHostProfile(
  handler: string,
  definition: TheoremHostHandlerOptions['profile'],
): Extract<Profile, { type: 'host' }> {
  const profile = defineProfile(definition as ProfileDefinition);
  if (profile.type !== 'host') {
    // labels-exempt: builder config error at setup; no user sees it
    throw new Error(`${handler} serves type 'host'; got type '${profile.type}'.`);
  }
  return profile;
}

/** A registered tool a host profile can serve: builtins run only inside a model's turn. */
export function hostTool(name: string) {
  const registered = defaultKernelScope.tools.get(name);
  return registered?.type === 'builtin' ? undefined : registered;
}

function serve(
  name: string,
  profile: Profile,
  options: HandlerContext['options'],
  chatOptions: { steerInbox?: SteerInbox; chat?: ChatContext; wire?: HandlerContext['wire'] } = {},
): (request: Request) => Promise<Response> {
  requestByteLimit(options.maxRequestBytes);
  const ctx: HandlerContext = {
    options,
    ...sessionParts(name, profile, options),
    ...(chatOptions.chat ? { chat: chatOptions.chat } : {}),
    inbox: chatOptions.steerInbox ?? createMemorySteerInbox(),
    wire: chatOptions.wire ?? createConversationCore,
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
