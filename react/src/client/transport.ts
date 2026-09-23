/**
 * Transport contract between a Theorem chat UI and the host that runs turns.
 *
 * The browser never holds the profile: it asks the transport to `describe` the
 * profile's client-safe interface, then streams turns / tool invokes through it.
 * `createHttpTransport` speaks to `createTheoremHandler` (`@theoremai/react/server`);
 * hosts with their own wire format implement {@link TheoremTransport} directly.
 *
 * @module
 */

import type { TurnEvent, TurnHistoryMessage } from '../../../mod.ts';
import type { ProfileInterface } from '../../../src/interface/mod.ts';
import type { ToolCredential, TurnToolSnapshot } from '../../../src/kernel/mod.ts';

type EncodedBlob = { name: string; mimeType: string; data: string };

/** Turn input as sent over the wire (media is base64-encoded). */
export type TheoremTurnInput = {
	text?: string;
	attachments?: EncodedBlob[];
	voice?: EncodedBlob[];
	history?: TurnHistoryMessage[];
	historyTokens?: number;
	inputTokens?: number;
};

/**
 * State only the client holds, for hosts whose profile also lives in the browser
 * (the playground). `createHttpTransport` never sends it: `createTheoremHandler`
 * keeps permissions, paused calls, and tool snapshots in its own session.
 */
export type TheoremReplay = {
	sessionPermissions?: string[];
	name?: string;
	input?: unknown;
	resume?: { value?: unknown; granted?: boolean };
	turnInput?: TheoremTurnInput;
	snapshot?: TurnToolSnapshot;
	promoted?: string[];
	model?: string;
	effort?: string;
	path?: string;
};

/** One text turn. The host resolves the profile; the client sends the conversation. */
export type TheoremTurnRequest = {
	input: TheoremTurnInput;
	previousInteractionId?: string;
	model?: string;
	effort?: string;
	/** Client-generated id so mid-turn steers can find this turn's inbox. */
	turnId?: string;
	replay?: Pick<TheoremReplay, 'sessionPermissions'>;
};

/** Approve a tool call the host paused on a gate; the host runs it as the model asked. */
export type TheoremInvokeRequest = {
	/** Call id of the paused tool call (`tool.callId` on its gate event). */
	gateId: string;
	decision: 'allow' | 'allow_session';
	/** User-entered secrets for an auth gate. */
	credentials?: Record<string, ToolCredential>;
	replay?: TheoremReplay;
};

/** Inject user messages into an in-flight turn. */
export type TheoremSteerRequest = {
	turnId: string;
	inject: TurnHistoryMessage[];
};

export type TurnEventSink = (event: TurnEvent) => void;

export interface TheoremTransport {
	/** Client-safe interface for the host's profile (inputs, models, guardrail view). */
	describe(signal?: AbortSignal): Promise<ProfileInterface>;
	turn(request: TheoremTurnRequest, onEvent: TurnEventSink, signal?: AbortSignal): Promise<void>;
	invoke(request: TheoremInvokeRequest, onEvent: TurnEventSink, signal?: AbortSignal): Promise<void>;
	steer(request: TheoremSteerRequest): Promise<void>;
}

/** Public-safe stream failure; `internalMessage` is only set when the host exposes it. */
export class TheoremStreamError extends Error {
	readonly publicMessage: string;
	readonly internalMessage?: string;

	constructor(publicMessage: string, internalMessage?: string) {
		super(publicMessage);
		this.name = 'TheoremStreamError';
		this.publicMessage = publicMessage;
		if (internalMessage) this.internalMessage = internalMessage;
	}
}

export function isTheoremStreamError(err: unknown): err is TheoremStreamError {
	return err instanceof TheoremStreamError;
}

export function isAbortError(err: unknown): boolean {
	return (
		(err instanceof DOMException && err.name === 'AbortError') ||
		(err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message)))
	);
}

function streamErrorFromEvent(event: { error?: string; errorInternal?: string }): TheoremStreamError {
	const pub = typeof event.error === 'string' ? event.error.trim() : '';
	const internal = typeof event.errorInternal === 'string' ? event.errorInternal.trim() : '';
	const publicMessage = pub || 'Something went wrong. Try again.';
	const internalMessage = internal && internal !== publicMessage ? internal : undefined;
	return new TheoremStreamError(publicMessage, internalMessage);
}

/** Any `{ type: 'error' }` line ends the stream as a {@link TheoremStreamError}. */
function parseStreamLine(line: string): TurnEvent {
	const event = JSON.parse(line) as TurnEvent | { type: 'error'; error?: string; errorInternal?: string };
	if (event.type === 'error') throw streamErrorFromEvent(event);
	return event;
}

function flushNdjsonChunk(buffer: string, onEvent: TurnEventSink): string {
	const lines = buffer.split('\n');
	const rest = lines.pop() ?? '';
	for (const line of lines) {
		if (!line.trim()) continue;
		onEvent(parseStreamLine(line));
	}
	return rest;
}

async function readNdjsonStream(
	response: Response,
	onEvent: TurnEventSink,
	signal?: AbortSignal,
): Promise<void> {
	if (!response.body) throw new Error('Stream missing body');

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	const onAbort = () => {
		void reader.cancel();
	};
	signal?.addEventListener('abort', onAbort, { once: true });

	try {
		for (;;) {
			if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
			const { done, value } = await reader.read();
			if (done) break;
			buffer = flushNdjsonChunk(buffer + decoder.decode(value, { stream: true }), onEvent);
		}
		const tail = buffer.trim();
		if (tail) onEvent(parseStreamLine(tail));
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
}

export type HttpOptions = {
	fetch?: typeof fetch;
	/** Extra request headers (auth tokens, CSRF). A function is re-read per request. */
	headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
	/** Cookie policy. Default `same-origin`; use `include` when the handler is on another origin. */
	credentials?: RequestCredentials;
};

async function resolveHeaders(options: HttpOptions): Promise<Headers> {
	const extra = typeof options.headers === 'function' ? await options.headers() : options.headers;
	const headers = new Headers(extra);
	headers.set('content-type', 'application/json');
	return headers;
}

async function failureFromResponse(response: Response, label: string): Promise<Error> {
	const payload = (await response.json().catch(() => ({}))) as { error?: string };
	return new Error(payload.error ?? `${label} (${String(response.status)})`);
}

async function request(
	url: string,
	init: RequestInit,
	options: HttpOptions,
): Promise<Response> {
	const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	try {
		return await doFetch(url, {
			...init,
			headers: await resolveHeaders(options),
			credentials: options.credentials ?? 'same-origin',
		});
	} catch (err) {
		if (isAbortError(err)) throw new DOMException('The operation was aborted.', 'AbortError');
		throw err;
	}
}

/** POST JSON and stream NDJSON turn events back. */
export async function postNdjson(
	url: string,
	body: unknown,
	onEvent: TurnEventSink,
	options: HttpOptions & { signal?: AbortSignal; failureLabel?: string } = {},
): Promise<void> {
	const response = await request(
		url,
		{ method: 'POST', body: JSON.stringify(body), signal: options.signal },
		options,
	);
	if (!response.ok) throw await failureFromResponse(response, options.failureLabel ?? 'Request failed');
	await readNdjsonStream(response, onEvent, options.signal);
}

/** POST JSON and read a JSON reply. */
export async function postJson<T>(
	url: string,
	body: unknown,
	options: HttpOptions & { failureLabel?: string } = {},
): Promise<T> {
	const response = await request(url, { method: 'POST', body: JSON.stringify(body) }, options);
	if (!response.ok) throw await failureFromResponse(response, options.failureLabel ?? 'Request failed');
	return (await response.json()) as T;
}

export type HttpTransportOptions = HttpOptions & {
	/** Base URL where `createTheoremHandler` is mounted. Default `/api/theorem`. */
	endpoint?: string;
};

/** Transport for a host mounted with `createTheoremHandler`. */
export function createHttpTransport(options: HttpTransportOptions = {}): TheoremTransport {
	const base = (options.endpoint ?? '/api/theorem').replace(/\/+$/, '');
	return {
		async describe(signal) {
			const response = await request(base, { method: 'GET', signal }, options);
			if (!response.ok) throw await failureFromResponse(response, 'Describe failed');
			return ((await response.json()) as { interface: ProfileInterface }).interface;
		},
		turn: ({ replay: _replay, ...body }, onEvent, signal) =>
			postNdjson(`${base}/turn`, body, onEvent, { ...options, signal, failureLabel: 'Turn failed' }),
		invoke: ({ replay: _replay, ...body }, onEvent, signal) =>
			postNdjson(`${base}/invoke`, body, onEvent, {
				...options,
				signal,
				failureLabel: 'Invoke failed',
			}),
		async steer(body) {
			await postJson(`${base}/steer`, body, { ...options, failureLabel: 'Steer failed' });
		},
	};
}
