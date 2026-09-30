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
 *
 * `createTheoremHostHandler` serves a host profile the same way, with no model:
 *
 * - `GET  <base>`         → `{ interface }` the tools the page may call, with their schemas
 * - `POST <base>/call`    → NDJSON events for one call of one of those tools
 * - `POST <base>/invoke`  → NDJSON events for the user's answer to a paused call
 *
 * Trust boundary: the browser owns the conversation text; the server owns every
 * decision that grants authority. Tool permissions, which paused calls may run
 * (and with what input), and which provider interactions may be continued are
 * kept in a server-side session — request bodies can't grant any of them.
 * Tool credentials are held on the server too: a key the user types at a gate
 * is sent once and saved, and no credential is ever sent back to the browser.
 *
 * @module
 */

import {
	type CreateProviderOptions,
	createProvider,
	defaultKernelScope,
	defineProfile,
	errorKind,
	invokeTool,
	lexiconText,
	type ModelProvider,
	type Profile,
	type ProfileDefinition,
	publicError,
	registerProfile,
	runTurn,
	TheoremError,
	type ToolGate,
	type TurnEvent,
	type TurnHistoryMessage,
	type TurnInput,
} from '@theoremjs/agents';
import {
	type ClientTurnOptions,
	caughtStatus,
	forClient,
	HTTP_METHOD,
} from '@theoremjs/agents/host';
import {
	type AnsweredGate,
	answerGatedCall,
	type GateAnswerRequest,
	isRecord,
	resolveGateTtlMs,
	toBase64Url,
} from '@theoremjs/agents/kernel';
import {
	hostInterface,
	type TheoremHostCallRequest,
	theoremHostCallRequestSchema,
} from '../client/host-transport.ts';
import {
	gatedToolsFromEvents,
	interfaceFromProfile,
	type ProfileInterface,
	promotedToolIdsFromEvents,
	settlesToolCall,
	toolSnapshotFromEvents,
} from '@theoremjs/agents/interface';
import type { z } from '@theoremjs/agents';
import {
	type TheoremInvokeRequest,
	theoremInvokeRequestSchema,
	type TheoremTurnInput,
	type TheoremTurnRequest,
	theoremSteerRequestSchema,
	theoremTurnRequestSchema,
} from '../client/transport.ts';
import {
	createMemoryCredentialStore,
	type TheoremCredentialStore,
	type TheoremCredentials,
} from './credential-store.ts';
import { checkRequest } from './request-check.ts';
import {
	createMemorySessionStore,
	emptySessionState,
	type PendingToolGate,
	type PerSessionStore,
	pruneGates,
	type SettledToolGate,
	type TheoremSessionState,
	type TheoremSessionStore,
} from './session-store.ts';
import { createMemorySteerInbox, type SteerInbox, steerStage, steerUnitOf } from './steer-inbox.ts';
import { checkWalkAway, walkAway } from './walk-away.ts';
import { jsonResponse } from './json-response.ts';

export type TheoremRequestContext = {
	request: Request;
	/** Selected model id, when the client picked one. */
	model?: string;
};

export type TheoremHandlerOptions = {
	/** Profile to serve. Registered with the kernel when the handler is created. */
	profile: Profile | ProfileDefinition;
	/**
	 * Provider credentials passed to `createProvider`, or a factory for hosts that
	 * pick keys per request (BYOK, tenant vaults). Tools are registered by the host.
	 */
	provider: CreateProviderOptions | ((ctx: TheoremRequestContext) => ModelProvider | Promise<ModelProvider>);
	/** Opaque app context for tool handlers (`ctx.host`) — e.g. the signed-in user. */
	host?: (request: Request) => unknown;
	/**
	 * Resolve the caller's session id — e.g. `${userId}:${conversationId}` from your
	 * auth. Return `undefined` to refuse the request (401). Default: an opaque id
	 * in an HttpOnly, SameSite=Lax cookie the handler issues on first contact.
	 */
	session?: (request: Request) => string | undefined | Promise<string | undefined>;
	/** Default: in-process memory. Use a shared store when requests can reach different instances. */
	sessionStore?: TheoremSessionStore;
	/**
	 * How long a gate (permission, confirmation, sign-in) waits for its answer, in
	 * milliseconds. An answer after that is refused with `session.gate_expired`.
	 * Default: 30 minutes.
	 */
	gateTtlMs?: number;
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
	/** Forwarded to `forClient` when projecting events for the browser. */
	clientEvents?: ClientTurnOptions;
	/**
	 * Called with any error the handler catches, for reporting. Users read the
	 * profile's lexicon wording for the error's kind, never the error itself.
	 */
	onError?: (err: unknown, ctx: { request: Request }) => void;
};

/** A host profile runs no model, and takes no turns to steer. */
export type TheoremHostHandlerOptions = Omit<TheoremHandlerOptions, 'profile' | 'provider' | 'steerInbox'> & {
	/** Host profile to serve. Registered with the kernel when the handler is created. */
	profile: Extract<Profile, { type: 'host' }> | Extract<ProfileDefinition, { type: 'host' }>;
};

const SESSION_COOKIE = 'theorem_session';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

const NDJSON_HEADERS = {
	'content-type': 'application/x-ndjson; charset=utf-8',
	'cache-control': 'no-store',
} as const;

type Session = { id: string; setCookie?: string };

function withSessionCookie(response: Response, session: Session | undefined): Response {
	if (session?.setCookie) response.headers.append('set-cookie', session.setCookie);
	return response;
}

/** Strip server-only identity (system prompts) from the projected interface. */
function clientInterface(profile: Profile): ProfileInterface {
	const iface = interfaceFromProfile(profile, defaultKernelScope.tools);
	return { ...iface, identity: { handle: iface.identity.handle } };
}

/** A JSON body checked against `schema`; a missing or malformed field is a `request` error (400). */
export async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
	// JSON-only POSTs can't be sent by a cross-site form, and force a CORS preflight.
	const type = request.headers.get('content-type') ?? '';
	if (!type.toLowerCase().startsWith('application/json')) {
		// lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
		throw new TheoremError('request', 'Content-Type must be application/json');
	}
	let raw: unknown;
	try {
		raw = await request.json();
	} catch (cause) {
		// lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
		throw new TheoremError('request', 'Request body must be JSON', { cause });
	}
	return checkRequest(schema, raw, 'request body');
}

/** Conversation messages a browser may supply — never system instructions. */
function conversationOnly(messages: readonly TurnHistoryMessage[]): TurnHistoryMessage[] {
	return messages.filter(
		(message) => message.role === 'user' || message.role === 'assistant' || message.role === 'tool',
	);
}

/**
 * Keep the user-authored parts of a turn input. Drops fields that would let a
 * client speak as the host: system-role history, `role`, `repair` guidance,
 * token-meter overrides, and live resumption handles.
 */
function userTurnInput(input: TheoremTurnInput): TurnInput {
	return {
		...(input.text !== undefined ? { text: input.text } : {}),
		...(input.attachments ? { attachments: input.attachments } : {}),
		...(input.voice ? { voice: input.voice } : {}),
		...(input.history ? { history: conversationOnly(input.history) } : {}),
	};
}

/** Last path segment after the mount point: '', 'turn', 'invoke', 'steer', or a host's 'call'. */
function routeOf(request: Request): string {
	const segments = new URL(request.url).pathname.split('/').filter(Boolean);
	const last = segments.at(-1) ?? '';
	return last === 'turn' || last === 'invoke' || last === 'steer' || last === 'call' ? last : '';
}

function readCookie(request: Request, name: string): string | undefined {
	for (const part of (request.headers.get('cookie') ?? '').split(';')) {
		const [key, ...rest] = part.trim().split('=');
		if (key === name) return rest.join('=');
	}
	return undefined;
}

function newSessionId(): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * The session id the handler issued in its cookie, for a host route outside the
 * handler (an OAuth callback) that saves credentials under it. Hosts that pass
 * a `session` resolver use their own id instead.
 */
export function theoremSessionId(request: Request): string | undefined {
	const existing = readCookie(request, SESSION_COOKIE);
	return existing && SESSION_ID_PATTERN.test(existing) ? existing : undefined;
}

function cookieSession(request: Request): Session {
	const existing = theoremSessionId(request);
	if (existing) return { id: existing };
	const id = newSessionId();
	const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
	return {
		id,
		setCookie: `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax${secure}`,
	};
}

/**
 * A store read and changed one request at a time per session, so concurrent
 * requests don't lose each other's updates. `loaded` tidies what the store held.
 */
type LockedStore<T> = {
	read(sessionId: string): Promise<T>;
	mutate<R>(sessionId: string, change: (value: T) => R): Promise<R>;
};

function lockedStore<T>(
	store: PerSessionStore<T>,
	loaded: (value: T | undefined) => T,
): LockedStore<T> {
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

/** Session state, with expired gates dropped as it loads so they can't be answered. */
function sessionStateStore(store: TheoremSessionStore, gateTtlMs: number): LockedStore<TheoremSessionState> {
	return lockedStore(store, (state = emptySessionState()) => ({
		...state,
		gates: pruneGates(state.gates, Date.now(), gateTtlMs),
		settled: pruneGates(state.settled, Date.now(), gateTtlMs),
	}));
}

/** Everything a request needs from the handler that serves it. */
type HandlerContext = {
	/** A host's handler has no provider: it runs no model. */
	options: Omit<TheoremHandlerOptions, 'profile' | 'provider'> & Partial<Pick<TheoremHandlerOptions, 'provider'>>;
	profile: Profile;
	inbox: SteerInbox;
	sessions: LockedStore<TheoremSessionState>;
	credentials: LockedStore<TheoremCredentials>;
};

async function sessionOf(ctx: HandlerContext, request: Request): Promise<Session> {
	if (!ctx.options.session) return cookieSession(request);
	const id = (await ctx.options.session(request))?.trim();
	if (!id) {
		// lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
		throw new TheoremError('auth', 'the session resolver refused the request', {
			copy: { key: 'session.sign_in' },
		});
	}
	return { id };
}

/** Reports the error to the host, then words it for the user from the profile's lexicon. */
function publicMessage(ctx: HandlerContext, err: unknown, request: Request): string {
	ctx.options.onError?.(err, { request });
	return publicError(err, ctx.profile.lexicon);
}

function eventStream(ctx: HandlerContext, request: Request, source: () => AsyncIterable<TurnEvent>): Response {
	const encoder = new TextEncoder();
	const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const event of source()) {
					controller.enqueue(line(forClient(event, ctx.options.clientEvents)));
				}
			} catch (err) {
				if (!request.signal.aborted) {
					controller.enqueue(
						line({ type: 'error', error: publicMessage(ctx, err, request), errorKind: errorKind(err) }),
					);
				}
			}
			controller.close();
		},
	});
	return new Response(stream, { headers: NDJSON_HEADERS });
}

function providerFor(ctx: HandlerContext, request: Request, model?: string): ModelProvider | Promise<ModelProvider> {
	const { provider } = ctx.options;
	// lexicon-exempt: builder config error; the user reads error.config
	if (!provider) throw new TheoremError('config', `profile ${ctx.profile.id} has no provider`);
	if (typeof provider === 'function') return provider({ request, model });
	return createProvider(ctx.profile, provider, model);
}

/** Steer inboxes are scoped to the session, so a turn id alone can't reach another user's turn. */
function inboxKey(sessionId: string, turnId: string): string {
	return `${sessionId}\u0000${turnId}`;
}

type OutcomeContext = { turnInput: TurnInput; model?: string; promoted?: string[] };

/** The exact paused calls the user may now approve, when the stream stopped on gates. */
function pendingGatesFrom(events: TurnEvent[], context: OutcomeContext): { callId: string; gate: PendingToolGate }[] {
	return gatedToolsFromEvents(events).map((gated) => ({
		callId: gated.callId,
		gate: {
			name: gated.name,
			arguments: gated.arguments,
			gate: { kind: gated.gateKind, permission: gated.permission, ...(gated.auth ? { auth: gated.auth } : {}) },
			snapshot: toolSnapshotFromEvents(events),
			promoted: [...new Set([...(context.promoted ?? []), ...promotedToolIdsFromEvents(events)])],
			turnInput: context.turnInput,
			model: context.model,
			createdAt: Date.now(),
		},
	}));
}

/**
 * Record what the stream established: interaction ids for continuation and,
 * when it paused on gates, the exact calls the user may now approve.
 */
async function recordOutcome(
	sessions: LockedStore<TheoremSessionState>,
	sessionId: string,
	events: TurnEvent[],
	context: OutcomeContext,
): Promise<void> {
	const interactionIds = events.flatMap((event) =>
		event.type === 'done' && event.interactionId ? [event.interactionId] : [],
	);
	const pending = pendingGatesFrom(events, context);
	if (!interactionIds.length && !pending.length) return;
	await sessions.mutate(sessionId, (state) => {
		state.interactions.push(...interactionIds);
		for (const { callId, gate } of pending) state.gates[callId] = gate;
	});
}

async function* recorded(
	sessions: LockedStore<TheoremSessionState>,
	sessionId: string,
	events: AsyncIterable<TurnEvent>,
	context: OutcomeContext,
): AsyncGenerator<TurnEvent> {
	const seen: TurnEvent[] = [];
	for await (const event of events) {
		seen.push(event);
		if (event.type === 'done') await recordOutcome(sessions, sessionId, seen, context);
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

/** The slot a refreshed OAuth token replaced, from its `auth_token_refreshed` event. */
function refreshedSlot(event: TurnEvent): string | undefined {
	const data = event.type === 'tool' && event.tool.phase === 'progress' ? event.tool.data : undefined;
	return isRecord(data) && data.kind === 'auth_token_refreshed' && typeof data.slot === 'string'
		? data.slot
		: undefined;
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
	if (!gate || gate.authChallenge.authType !== 'oauth2' || !ctx.options.authorizationUrl) return event;
	const challenge = gate.authChallenge;
	const authorizationUrl = await ctx.options.authorizationUrl(challenge, { request, sessionId });
	return {
		...event,
		tool: { ...tool, gate: { ...gate, authChallenge: { ...challenge, authorizationUrl } } },
	};
}

/**
 * The server's side of a turn's credentials. The kernel writes a refreshed
 * token into the `credentials` record it was given: that slot is saved before
 * the event goes on, so a rotated refresh token is never lost to a closed
 * stream. An OAuth gate gets the host's sign-in URL.
 */
async function* withCredentials(
	ctx: HandlerContext,
	request: Request,
	sessionId: string,
	credentials: TheoremCredentials,
	events: AsyncIterable<TurnEvent>,
): AsyncGenerator<TurnEvent> {
	for await (const event of events) {
		const slot = refreshedSlot(event);
		const credential = slot ? credentials[slot] : undefined;
		if (slot && credential) await saveCredential(ctx, sessionId, slot, credential);
		yield await withAuthorizationUrl(ctx, request, sessionId, event);
	}
}

/** The session's paused call, answered and taken out: each answer settles it once, as the model asked it. */
type AnsweredCall = { callId: string; pending: PendingToolGate; answer: AnsweredGate };

function answerPendingGate(state: TheoremSessionState, request: GateAnswerRequest): AnsweredCall {
	const pending = state.gates[request.callId];
	if (!pending) {
		// lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
		throw new TheoremError('request', `gate ${request.callId} is not pending`, {
			copy: { key: 'session.gate_expired' },
		});
	}
	// A refused answer (a refused secret, an edit without an approval) throws here and leaves the gate pending.
	const answer = answerGatedCall(
		request,
		{
			name: pending.name,
			arguments: pending.arguments,
			permission: pending.gate.permission,
			...(pending.gate.kind === 'auth' && pending.gate.auth ? { auth: pending.gate.auth } : {}),
		},
		state.permissions,
	);
	delete state.gates[request.callId];
	state.permissions = answer.sessionPermissions;
	return { callId: request.callId, pending, answer };
}

/** A call a message walks away from: taken from its gate now, or settled by an earlier request its client never heard. */
type WalkedCall = AnsweredCall | { callId: string; settled: SettledToolGate };

function walkedCallOf(state: TheoremSessionState, callId: string): WalkedCall {
	const settled = state.settled[callId];
	return settled ? { callId, settled } : answerPendingGate(state, { callId, decision: 'abandon' });
}

/**
 * Take the calls a message walks away from out of the session, answered
 * `abandon`: every one of them, or none when one is neither waiting nor
 * settled. The message's history must leave exactly those calls open.
 */
function takeWalkedAway(
	ctx: HandlerContext,
	session: Session,
	input: TurnInput,
	abandon: readonly string[],
): Promise<WalkedCall[]> {
	checkWalkAway(input, abandon);
	// A throw leaves the session unsaved, so no call is taken unless all are.
	return ctx.sessions.mutate(session.id, (state) => abandon.map((callId) => walkedCallOf(state, callId)));
}

/**
 * The run that settles an answered call, as the model asked it. The session
 * keeps the event that settles it, and `ended` names the call once it has
 * (see `restoreUnended`).
 */
async function* settleAnswered(
	ctx: HandlerContext,
	request: Request,
	session: Session,
	answered: AnsweredCall,
	credentials: TheoremCredentials,
	ended: Set<string>,
): AsyncGenerator<TurnEvent> {
	const { callId, pending } = answered;
	for await (const event of invokeAnswered(ctx, request, answered, credentials)) {
		if (!ended.has(callId) && settlesToolCall(event, callId)) {
			ended.add(callId);
			await ctx.sessions.mutate(session.id, (state) => {
				state.settled[callId] = { event, createdAt: pending.createdAt };
			});
		}
		yield event;
	}
}

/**
 * A request that took calls and ended before they settled (the client went
 * away, the host failed, an earlier call's run threw) puts each back to wait
 * as it did, to be answered again, unless it paused on a gate again: the run
 * recorded that gate with its outcome.
 */
async function restoreUnended(
	ctx: HandlerContext,
	session: Session,
	calls: readonly WalkedCall[],
	ended: ReadonlySet<string>,
): Promise<void> {
	const unended = calls.flatMap((call) => ('pending' in call && !ended.has(call.callId) ? [call] : []));
	if (!unended.length) return;
	await ctx.sessions.mutate(session.id, (state) => {
		for (const { callId, pending } of unended) state.gates[callId] ??= pending;
	});
}

function invokeAnswered(
	ctx: HandlerContext,
	request: Request,
	{ callId, pending, answer }: AnsweredCall,
	credentials: TheoremCredentials,
): AsyncGenerator<TurnEvent> {
	return invokeTool({
		profile: ctx.profile.id,
		name: pending.name,
		callId,
		input: answer.input,
		resume: answer.resume,
		sessionPermissions: answer.sessionPermissions,
		credentials,
		turnInput: pending.turnInput,
		snapshot: pending.snapshot,
		promoted: pending.promoted,
		model: pending.model,
		signal: request.signal,
		host: ctx.options.host?.(request),
	});
}

/** Settles each walked-away call, and returns the input with their answers. */
async function* walkAwayFrom(
	ctx: HandlerContext,
	request: Request,
	session: Session,
	walked: { input: TurnInput; calls: readonly WalkedCall[] },
	ended: Set<string>,
): AsyncGenerator<TurnEvent, TurnInput | undefined> {
	const credentials = await ctx.credentials.read(session.id);
	return yield* walkAway(
		walked.input,
		walked.calls.map((call) => ({
			callId: call.callId,
			events:
				'settled' in call
					? once(call.settled.event)
					: settleAnswered(ctx, request, session, call, credentials, ended),
		})),
	);
}

/** A settled call's answer, streamed again. */
async function* once(event: TurnEvent): AsyncGenerator<TurnEvent> {
	yield event;
}

async function* turnEvents(
	ctx: HandlerContext,
	request: Request,
	session: Session,
	body: TheoremTurnRequest,
	walked: { input: TurnInput; calls: WalkedCall[] },
): AsyncGenerator<TurnEvent> {
	const ended = new Set<string>();
	let input: TurnInput | undefined;
	try {
		input = walked.calls.length ? yield* walkAwayFrom(ctx, request, session, walked, ended) : walked.input;
	} finally {
		await restoreUnended(ctx, session, walked.calls, ended);
	}
	if (!input) return;
	const state = await ctx.sessions.read(session.id);
	const credentials = await ctx.credentials.read(session.id);
	const provider = await providerFor(ctx, request, body.model);
	// Only continue provider-side conversations this session started.
	const previousInteractionId =
		body.previousInteractionId && state.interactions.includes(body.previousInteractionId)
			? body.previousInteractionId
			: undefined;
	const key = body.turnId ? inboxKey(session.id, body.turnId) : undefined;
	if (key) await ctx.inbox.open(key);
	try {
		const events = runTurn(
			{
				profile: ctx.profile.id,
				input,
				previousInteractionId,
				sessionPermissions: state.permissions,
				credentials,
				signal: request.signal,
				host: ctx.options.host?.(request),
				...(body.model ? { model: body.model } : {}),
				...(body.effort ? { effort: body.effort } : {}),
				...(key ? { onStage: steerStage(ctx.inbox, key) } : {}),
			},
			provider,
		);
		yield* recorded(ctx.sessions, session.id, withCredentials(ctx, request, session.id, credentials, events), {
			turnInput: input,
			model: body.model,
		});
	} finally {
		if (key) await ctx.inbox.close(key);
	}
}

async function* invokeEvents(
	ctx: HandlerContext,
	request: Request,
	session: Session,
	answered: AnsweredCall,
): AsyncGenerator<TurnEvent> {
	const { pending, answer } = answered;
	const ended = new Set<string>();
	try {
		if (answer.typed) await saveCredential(ctx, session.id, answer.typed.slot, answer.typed.credential);
		const credentials = await ctx.credentials.read(session.id);
		const events = settleAnswered(ctx, request, session, answered, credentials, ended);
		yield* recorded(ctx.sessions, session.id, withCredentials(ctx, request, session.id, credentials, events), {
			turnInput: pending.turnInput,
			model: pending.model,
			promoted: pending.promoted,
		});
	} finally {
		await restoreUnended(ctx, session, [answered], ended);
	}
}

async function steer(ctx: HandlerContext, request: Request, session: Session): Promise<Response> {
	const body = await readBody(request, theoremSteerRequestSchema);
	if (!(await ctx.inbox.enqueue(inboxKey(session.id, body.turnId), steerUnitOf(body)))) {
		// lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
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
	const credentials = await ctx.credentials.read(session.id);
	const events = invokeTool({
		profile: ctx.profile.id,
		name: body.name,
		input: body.input,
		sessionPermissions: state.permissions,
		credentials,
		signal: request.signal,
		host: ctx.options.host?.(request),
	});
	yield* recorded(ctx.sessions, session.id, withCredentials(ctx, request, session.id, credentials, events), {
		turnInput: {},
	});
}

function answerRequest(body: TheoremInvokeRequest): GateAnswerRequest {
	return { callId: body.gateId, decision: body.decision, input: body.input, secret: body.secret };
}

/** A route this profile doesn't serve. */
function refused(ctx: HandlerContext): Response {
	return jsonResponse(HTTP_METHOD, {
		error: lexiconText('error.request', {}, ctx.profile.lexicon),
		errorKind: 'request',
	});
}

/** The user's answer to a paused call. */
async function invoke(ctx: HandlerContext, request: Request, session: Session): Promise<Response> {
	const body = await readBody(request, theoremInvokeRequestSchema);
	// Take the answered call before streaming, so a stale answer is a reply status, not a stream error.
	const answered = await ctx.sessions.mutate(session.id, (state) => answerPendingGate(state, answerRequest(body)));
	return eventStream(ctx, request, () => invokeEvents(ctx, request, session, answered));
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
		const body = await readBody(request, theoremHostCallRequestSchema);
		return eventStream(ctx, request, () => callEvents(ctx, request, session, body));
	}
	if (request.method === 'POST' && target === 'invoke') return invoke(ctx, request, session);
	return refused(ctx);
}

async function route(ctx: HandlerContext, request: Request, session: Session): Promise<Response> {
	if (ctx.profile.type === 'host') return hostRoute({ ...ctx, profile: ctx.profile }, request, session);
	const target = routeOf(request);
	if (request.method === 'GET' && target === '') return jsonResponse(200, { interface: clientInterface(ctx.profile) });
	if (request.method !== 'POST' || target === '' || target === 'call') return refused(ctx);
	if (target === 'turn') {
		const body = await readBody(request, theoremTurnRequestSchema);
		const input = userTurnInput(body.input);
		// Take the walked-away calls before streaming, so a stale one is a reply status, not a stream error.
		const calls = body.abandon ? await takeWalkedAway(ctx, session, input, body.abandon) : [];
		return eventStream(ctx, request, () => turnEvents(ctx, request, session, body, { input, calls }));
	}
	if (target === 'invoke') return invoke(ctx, request, session);
	return steer(ctx, request, session);
}

export function createTheoremHandler(options: TheoremHandlerOptions): (request: Request) => Promise<Response> {
	const profile = defineProfile(options.profile as ProfileDefinition);
	if (profile.type === 'decision') {
		// lexicon-exempt: builder config error at setup; no user sees it
		throw new Error("createTheoremHandler serves turn-based profiles; serve type 'decision' with createTheoremDecisionHandler.");
	}
	if (profile.type === 'host') {
		// lexicon-exempt: builder config error at setup; no user sees it
		throw new Error("createTheoremHandler serves turn-based profiles; serve type 'host' with createTheoremHostHandler.");
	}
	if (profile.type === 'live') {
		// lexicon-exempt: builder config error at setup; no user sees it
		throw new Error(`createTheoremHandler serves turn-based profiles; got type '${profile.type}'.`);
	}
	return serve('createTheoremHandler', profile, options, options.steerInbox);
}

/**
 * Serves a host profile to `<TheoremHost />`: the page calls the profile's tools
 * directly, and every call runs through the kernel's gates and guardrails.
 */
export function createTheoremHostHandler(options: TheoremHostHandlerOptions): (request: Request) => Promise<Response> {
	const profile = defineProfile(options.profile as ProfileDefinition);
	if (profile.type !== 'host') {
		// lexicon-exempt: builder config error at setup; no user sees it
		throw new Error(`createTheoremHostHandler serves type 'host'; got type '${profile.type}'.`);
	}
	return serve('createTheoremHostHandler', profile, options);
}

function serve(
	name: string,
	profile: Profile,
	options: HandlerContext['options'],
	steerInbox?: SteerInbox,
): (request: Request) => Promise<Response> {
	const gateTtlMs = resolveGateTtlMs(name, options.gateTtlMs);
	registerProfile(profile);
	const ctx: HandlerContext = {
		options,
		profile,
		inbox: steerInbox ?? createMemorySteerInbox(),
		sessions: sessionStateStore(options.sessionStore ?? createMemorySessionStore(), gateTtlMs),
		credentials: lockedStore(options.credentialStore ?? createMemoryCredentialStore(), (saved = {}) => saved),
	};

	return async (request) => {
		let session: Session | undefined;
		try {
			session = await sessionOf(ctx, request);
			return withSessionCookie(await route(ctx, request, session), session);
		} catch (err) {
			const error = publicMessage(ctx, err, request);
			return withSessionCookie(
				jsonResponse(caughtStatus(err), { error, errorKind: errorKind(err) }),
				session,
			);
		}
	};
}
