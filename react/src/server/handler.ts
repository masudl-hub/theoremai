/**
 * One Web-standard handler that serves a Theorem chat UI for a single profile.
 *
 * Mount it on any framework that speaks `Request` → `Response` (Deno.serve,
 * Hono, Next route handlers, SvelteKit, Workers) under a catch-all route:
 *
 * - `GET  <base>`         → `{ interface }` client-safe profile interface
 * - `POST <base>/turn`    → NDJSON turn events
 * - `POST <base>/invoke`  → NDJSON events for an approved, paused tool call
 * - `POST <base>/steer`   → inject messages into a running turn
 *
 * Trust boundary: the browser owns the conversation text; the server owns every
 * decision that grants authority. Tool permissions, which paused calls may run
 * (and with what input), and which provider interactions may be continued are
 * kept in a server-side session — request bodies can't grant any of them.
 *
 * @module
 */

import {
	type CreateProviderOptions,
	createProvider,
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
	type StageHandler,
	TheoremError,
	type TurnEvent,
	type TurnHistoryMessage,
	type TurnInput,
} from '../../../mod.ts';
import { type ClientTurnOptions, caughtStatus, forClient, HTTP_METHOD } from '../../../src/host/mod.ts';
import { toBase64Url } from '../../../src/kernel/mod.ts';
import {
	gatedToolFromEvents,
	interfaceFromProfile,
	type ProfileInterface,
	promotedToolIdsFromEvents,
	toolSnapshotFromEvents,
} from '../../../src/interface/mod.ts';
import { sessionPermissionsAfterApproval } from '../client/tool-resume.ts';
import type {
	TheoremInvokeRequest,
	TheoremSteerRequest,
	TheoremTurnInput,
	TheoremTurnRequest,
} from '../client/transport.ts';
import {
	createMemorySessionStore,
	emptySessionState,
	MAX_INTERACTIONS,
	type PendingToolGate,
	pruneGates,
	type TheoremSessionState,
	type TheoremSessionStore,
} from './session-store.ts';
import { createMemorySteerInbox, type SteerInbox } from './steer-inbox.ts';

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

const STEER_STAGES = new Set(['pre_turn', 'post_tool', 'before_end']);
const SESSION_COOKIE = 'theorem_session';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

const NDJSON_HEADERS = {
	'content-type': 'application/x-ndjson; charset=utf-8',
	'cache-control': 'no-store',
} as const;

type Session = { id: string; setCookie?: string };

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

function withSessionCookie(response: Response, session: Session | undefined): Response {
	if (session?.setCookie) response.headers.append('set-cookie', session.setCookie);
	return response;
}

/** Strip server-only identity (system prompts) from the projected interface. */
function clientInterface(profile: Profile): ProfileInterface {
	const iface = interfaceFromProfile(profile);
	return { ...iface, identity: { handle: iface.identity.handle } };
}

async function readJson<T>(request: Request): Promise<T> {
	// JSON-only POSTs can't be sent by a cross-site form, and force a CORS preflight.
	const type = request.headers.get('content-type') ?? '';
	if (!type.toLowerCase().startsWith('application/json')) {
		// lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
		throw new TheoremError('request', 'Content-Type must be application/json');
	}
	try {
		return (await request.json()) as T;
	} catch (cause) {
		// lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
		throw new TheoremError('request', 'Request body must be JSON', { cause });
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertTurnBody(body: unknown): asserts body is TheoremTurnRequest {
	// lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
	if (!isRecord(body) || !isRecord(body.input)) throw new TheoremError('request', 'input is required');
}

function assertInvokeBody(body: unknown): asserts body is TheoremInvokeRequest {
	if (!isRecord(body) || typeof body.gateId !== 'string' || !body.gateId) {
		// lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
		throw new TheoremError('request', 'gateId is required');
	}
}

function assertSteerBody(body: unknown): asserts body is TheoremSteerRequest {
	if (!isRecord(body) || typeof body.turnId !== 'string' || !body.turnId.trim()) {
		// lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
		throw new TheoremError('request', 'turnId is required');
	}
	if (!Array.isArray(body.inject) || body.inject.length === 0) {
		// lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
		throw new TheoremError('request', 'inject must be a non-empty array');
	}
}

/** Conversation messages a browser may supply — never system instructions. */
function conversationOnly(messages: unknown): TurnHistoryMessage[] {
	if (!Array.isArray(messages)) return [];
	return messages.filter(
		(message): message is TurnHistoryMessage =>
			isRecord(message) &&
			(message.role === 'user' || message.role === 'assistant' || message.role === 'tool'),
	);
}

/**
 * Keep the user-authored parts of a turn input. Drops fields that would let a
 * client speak as the host: system-role history, `role`, `repair` guidance,
 * token-meter overrides, and live resumption handles.
 */
function userTurnInput(input: TheoremTurnInput): TurnInput {
	const out: TurnInput = {};
	if (typeof input.text === 'string') out.text = input.text;
	if (Array.isArray(input.attachments)) out.attachments = input.attachments;
	if (Array.isArray(input.voice)) out.voice = input.voice;
	if (input.history !== undefined) out.history = conversationOnly(input.history);
	return out;
}

/** Last path segment after the mount point: '', 'turn', 'invoke', or 'steer'. */
function routeOf(request: Request): string {
	const segments = new URL(request.url).pathname.split('/').filter(Boolean);
	const last = segments.at(-1) ?? '';
	return last === 'turn' || last === 'invoke' || last === 'steer' ? last : '';
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

function cookieSession(request: Request): Session {
	const existing = readCookie(request, SESSION_COOKIE);
	if (existing && SESSION_ID_PATTERN.test(existing)) return { id: existing };
	const id = newSessionId();
	const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
	return {
		id,
		setCookie: `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax${secure}`,
	};
}

type SessionMutator = {
	/** Serialise read-modify-write per session so concurrent requests don't lose updates. */
	mutate<T>(sessionId: string, change: (state: TheoremSessionState) => T): Promise<T>;
	read(sessionId: string): Promise<TheoremSessionState>;
};

function createSessionMutator(store: TheoremSessionStore): SessionMutator {
	const locks = new Map<string, Promise<unknown>>();
	return {
		mutate(sessionId, change) {
			const previous = locks.get(sessionId) ?? Promise.resolve();
			const next = previous.then(async () => {
				const state = (await store.load(sessionId)) ?? emptySessionState();
				const result = change(state);
				state.gates = pruneGates(state.gates, Date.now());
				state.interactions = state.interactions.slice(-MAX_INTERACTIONS);
				await store.save(sessionId, state);
				return result;
			});
			const settled = next.catch(() => {});
			locks.set(sessionId, settled);
			void settled.then(() => {
				if (locks.get(sessionId) === settled) locks.delete(sessionId);
			});
			return next;
		},
		async read(sessionId) {
			return (await store.load(sessionId)) ?? emptySessionState();
		},
	};
}

/** Everything a request needs from the handler that serves it. */
type HandlerContext = {
	options: TheoremHandlerOptions;
	profile: Profile;
	inbox: SteerInbox;
	sessions: SessionMutator;
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
	if (typeof ctx.options.provider === 'function') return ctx.options.provider({ request, model });
	return createProvider(ctx.profile, ctx.options.provider, model);
}

/** Steer inboxes are scoped to the session, so a turn id alone can't reach another user's turn. */
function inboxKey(sessionId: string, turnId: string): string {
	return `${sessionId}\u0000${turnId}`;
}

function steerStage(inbox: SteerInbox, key: string): StageHandler {
	return async ({ stage }) => {
		if (!STEER_STAGES.has(stage)) return;
		const inject: TurnHistoryMessage[] | undefined = await inbox.consume(key);
		return inject?.length ? { inject } : undefined;
	};
}

type OutcomeContext = { turnInput: TurnInput; model?: string; promoted?: string[] };

/** The exact paused call the user may now approve, when the stream stopped on a gate. */
function pendingGateFrom(events: TurnEvent[], context: OutcomeContext): { callId: string; gate: PendingToolGate } | undefined {
	const gated = gatedToolFromEvents(events);
	if (!gated?.callId) return undefined;
	return {
		callId: gated.callId,
		gate: {
			name: gated.name,
			input: gated.input,
			gate: { kind: gated.gateKind, permission: gated.permission },
			snapshot: toolSnapshotFromEvents(events),
			promoted: [...new Set([...(context.promoted ?? []), ...promotedToolIdsFromEvents(events)])],
			turnInput: context.turnInput,
			model: context.model,
			createdAt: Date.now(),
		},
	};
}

/**
 * Record what the stream established: interaction ids for continuation and,
 * when it paused on a gate, the exact call the user may now approve.
 */
async function recordOutcome(
	sessions: SessionMutator,
	sessionId: string,
	events: TurnEvent[],
	context: OutcomeContext,
): Promise<void> {
	const interactionIds = events.flatMap((event) =>
		event.type === 'done' && event.interactionId ? [event.interactionId] : [],
	);
	const pending = pendingGateFrom(events, context);
	if (!interactionIds.length && !pending) return;
	await sessions.mutate(sessionId, (state) => {
		state.interactions.push(...interactionIds);
		if (pending) state.gates[pending.callId] = pending.gate;
	});
}

async function* recorded(
	sessions: SessionMutator,
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

async function* turnEvents(
	ctx: HandlerContext,
	request: Request,
	session: Session,
	body: TheoremTurnRequest,
): AsyncGenerator<TurnEvent> {
	const state = await ctx.sessions.read(session.id);
	const provider = await providerFor(ctx, request, body.model);
	const input = userTurnInput(body.input);
	// Only continue provider-side conversations this session started.
	const previousInteractionId =
		body.previousInteractionId && state.interactions.includes(body.previousInteractionId)
			? body.previousInteractionId
			: undefined;
	const turnId = body.turnId?.trim();
	const key = turnId ? inboxKey(session.id, turnId) : undefined;
	if (key) await ctx.inbox.open(key);
	try {
		const events = runTurn(
			{
				profile: ctx.profile.id,
				input,
				previousInteractionId,
				sessionPermissions: state.permissions,
				signal: request.signal,
				host: ctx.options.host?.(request),
				...(body.model ? { model: body.model } : {}),
				...(body.effort ? { effort: body.effort } : {}),
				...(key ? { onStage: steerStage(ctx.inbox, key) } : {}),
			},
			provider,
		);
		yield* recorded(ctx.sessions, session.id, events, { turnInput: input, model: body.model });
	} finally {
		if (key) await ctx.inbox.close(key);
	}
}

async function* invokeEvents(
	ctx: HandlerContext,
	request: Request,
	session: Session,
	body: TheoremInvokeRequest,
): AsyncGenerator<TurnEvent> {
	// Take the paused call out of the session: each approval runs it once, exactly as the model asked.
	const approved = await ctx.sessions.mutate(session.id, (state) => {
		const pending = state.gates[body.gateId];
		if (!pending) return undefined;
		delete state.gates[body.gateId];
		state.permissions = sessionPermissionsAfterApproval(
			state.permissions,
			pending.name,
			pending.gate.permission,
		);
		return { pending, permissions: [...state.permissions] };
	});
	if (!approved) {
		// lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
		throw new TheoremError('request', `gate ${body.gateId} is not pending`, {
			copy: { key: 'session.gate_expired' },
		});
	}
	const { pending, permissions } = approved;
	const events = invokeTool({
		profile: ctx.profile.id,
		name: pending.name,
		input: pending.input,
		resume: { granted: true },
		sessionPermissions: permissions,
		...(pending.gate.kind === 'auth' && body.credentials ? { credentials: body.credentials } : {}),
		turnInput: pending.turnInput,
		snapshot: pending.snapshot,
		promoted: pending.promoted,
		model: pending.model,
		signal: request.signal,
		host: ctx.options.host?.(request),
	});
	yield* recorded(ctx.sessions, session.id, events, {
		turnInput: pending.turnInput,
		model: pending.model,
		promoted: pending.promoted,
	});
}

async function steer(ctx: HandlerContext, session: Session, body: unknown): Promise<Response> {
	assertSteerBody(body);
	const inject = conversationOnly(body.inject).filter((message) => message.role === 'user');
	// lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
	if (!inject.length) throw new TheoremError('request', 'inject must contain user messages');
	const accepted = await ctx.inbox.enqueue(inboxKey(session.id, body.turnId.trim()), inject);
	if (!accepted) {
		// lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
		throw new TheoremError('request', `turn ${body.turnId.trim()} is not running`, {
			copy: { key: 'session.turn_ended' },
		});
	}
	return jsonResponse(200, { ok: true });
}

async function route(ctx: HandlerContext, request: Request, session: Session): Promise<Response> {
	const target = routeOf(request);
	if (request.method === 'GET' && target === '') return jsonResponse(200, { interface: clientInterface(ctx.profile) });
	if (request.method !== 'POST' || target === '') {
		return jsonResponse(HTTP_METHOD, {
			error: lexiconText('error.request', {}, ctx.profile.lexicon),
			errorKind: 'request',
		});
	}
	const body = await readJson<unknown>(request);
	if (target === 'turn') {
		assertTurnBody(body);
		return eventStream(ctx, request, () => turnEvents(ctx, request, session, body));
	}
	if (target === 'invoke') {
		assertInvokeBody(body);
		// Resolve the approval before streaming so a stale one is a reply status, not a stream error.
		const events = invokeEvents(ctx, request, session, body);
		const first = await events.next();
		return eventStream(ctx, request, async function* () {
			if (!first.done) yield first.value;
			yield* events;
		});
	}
	return steer(ctx, session, body);
}

export function createTheoremHandler(options: TheoremHandlerOptions): (request: Request) => Promise<Response> {
	const profile = defineProfile(options.profile as ProfileDefinition);
	if (profile.type === 'live' || profile.type === 'host') {
		// lexicon-exempt: builder config error at setup; no user sees it
		throw new Error(`createTheoremHandler serves turn-based profiles; got type '${profile.type}'.`);
	}
	registerProfile(profile);
	const ctx: HandlerContext = {
		options,
		profile,
		inbox: options.steerInbox ?? createMemorySteerInbox(),
		sessions: createSessionMutator(options.sessionStore ?? createMemorySessionStore()),
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
