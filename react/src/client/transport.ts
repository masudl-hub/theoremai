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

import {
	describeError,
	ERROR_KINDS,
	type ErrorKind,
	isAbortError,
	TheoremError,
	throwIfAborted,
	type TurnEvent,
	type TurnHistoryMessage,
} from '../../../mod.ts';
import { kindOfHttpStatus } from '../../../src/guardrails/mod.ts';
import type { ProfileInterface } from '../../../src/interface/mod.ts';
import type { ToolCredential, TurnToolSnapshot } from '../../../src/kernel/mod.ts';
import type { TraceFeed } from './trace-feed.ts';

export type EncodedBlob = { name: string; mimeType: string; data: string };

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

/**
 * Approve a tool call the host paused on a gate; the host runs it as the model asked.
 * The tool's registered permission decides how long the approval lasts, not the client.
 */
export type TheoremInvokeRequest = {
	/** Call id of the paused tool call (`tool.callId` on its gate event). */
	gateId: string;
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
	/** Trace records the host sends back, when it delivers them (the playground does). */
	traces?: TraceFeed;
}

/**
 * A failure the host reported: its kind, the host's wording when it sent one
 * (the profile's lexicon, applied on the host), and raw detail when the host
 * exposes it. `clientFailure` words it for the user.
 */
export class TheoremStreamError extends Error {
	readonly kind: ErrorKind;
	readonly publicMessage?: string;
	readonly internalMessage?: string;

	constructor(kind: ErrorKind, publicMessage?: string, internalMessage?: string) {
		super(internalMessage ?? publicMessage ?? kind);
		this.name = 'TheoremStreamError';
		this.kind = kind;
		if (publicMessage) this.publicMessage = publicMessage;
		if (internalMessage) this.internalMessage = internalMessage;
	}
}

export function isTheoremStreamError(err: unknown): err is TheoremStreamError {
	return err instanceof TheoremStreamError;
}

/** The trimmed string, or undefined when absent or blank. */
function textOf(value: unknown): string | undefined {
	const text = typeof value === 'string' ? value.trim() : '';
	return text || undefined;
}

/** A host error reply's body (JSON reply or `{ type: 'error' }` stream line). */
export type HostErrorBody = { error?: unknown; errorKind?: unknown; errorInternal?: unknown };

function isErrorKind(value: unknown): value is ErrorKind {
	return typeof value === 'string' && (ERROR_KINDS as readonly string[]).includes(value);
}

/** A host's error body as a failure: its kind when valid (else `fallbackKind`), wording, and detail. */
export function hostError(body: HostErrorBody, fallbackKind: ErrorKind): TheoremStreamError {
	const publicMessage = textOf(body.error);
	const internal = textOf(body.errorInternal);
	return new TheoremStreamError(
		isErrorKind(body.errorKind) ? body.errorKind : fallbackKind,
		publicMessage,
		internal && internal !== publicMessage ? internal : undefined,
	);
}

/** One NDJSON line: a turn event, or a host's own line type beside them. */
type StreamLine = { type: string };

/** Any `{ type: 'error' }` line ends the stream as a {@link TheoremStreamError}. */
function parseStreamLine<Line extends StreamLine>(line: string): Line {
	const parsed = JSON.parse(line) as Line & HostErrorBody;
	if (parsed.type === 'error') throw hostError(parsed, 'internal');
	return parsed;
}

function flushNdjsonChunk<Line extends StreamLine>(buffer: string, onLine: (line: Line) => void): string {
	const lines = buffer.split('\n');
	const rest = lines.pop() ?? '';
	for (const line of lines) {
		if (!line.trim()) continue;
		onLine(parseStreamLine<Line>(line));
	}
	return rest;
}

async function readNdjsonStream<Line extends StreamLine>(
	response: Response,
	onLine: (line: Line) => void,
	signal?: AbortSignal,
): Promise<void> {
	if (!response.body) throw new TheoremError('bad_response', 'stream reply has no body'); // lexicon-exempt: internal diagnostic

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	const onAbort = () => {
		void reader.cancel();
	};
	signal?.addEventListener('abort', onAbort, { once: true });

	try {
		for (;;) {
			throwIfAborted(signal);
			const { done, value } = await reader.read();
			if (done) break;
			buffer = flushNdjsonChunk(buffer + decoder.decode(value, { stream: true }), onLine);
		}
		const tail = buffer.trim();
		if (tail) onLine(parseStreamLine<Line>(tail));
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

/** A non-OK reply as a failure: the host's kind and wording, else the status's kind. */
async function failureFromResponse(response: Response): Promise<TheoremStreamError> {
	const body = (await response.json().catch(() => ({}))) as HostErrorBody;
	return hostError(
		{ ...body, errorInternal: body.errorInternal ?? `HTTP ${String(response.status)}` },
		kindOfHttpStatus(response.status),
	);
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
		if (isAbortError(err)) throw err;
		throw new TheoremError('network', describeError(err), { cause: err });
	}
}

/** POST JSON and stream NDJSON lines back: turn events, unless the host adds its own line types. */
export async function postNdjson<Line extends StreamLine = TurnEvent>(
	url: string,
	body: unknown,
	onLine: (line: Line) => void,
	options: HttpOptions & { signal?: AbortSignal } = {},
): Promise<void> {
	const response = await request(
		url,
		{ method: 'POST', body: JSON.stringify(body), signal: options.signal },
		options,
	);
	if (!response.ok) throw await failureFromResponse(response);
	await readNdjsonStream(response, onLine, options.signal);
}

/** POST JSON and read a JSON reply. */
export async function postJson<T>(
	url: string,
	body: unknown,
	options: HttpOptions = {},
): Promise<T> {
	const response = await request(url, { method: 'POST', body: JSON.stringify(body) }, options);
	if (!response.ok) throw await failureFromResponse(response);
	return (await response.json()) as T;
}

export type HttpTransportOptions = HttpOptions & {
	/** Base URL where `createTheoremHandler` is mounted. Default `/api/theorem`. */
	endpoint?: string;
};

/** Drops trailing '/'s by scanning back, not with a regex (a `/\/+$/` scan is quadratic on long runs of '/'). */
function withoutTrailingSlashes(url: string): string {
	let end = url.length;
	while (end > 0 && url[end - 1] === '/') end -= 1;
	return url.slice(0, end);
}

/** Transport for a host mounted with `createTheoremHandler`. */
export function createHttpTransport(options: HttpTransportOptions = {}): TheoremTransport {
	const base = withoutTrailingSlashes(options.endpoint ?? '/api/theorem');
	return {
		async describe(signal) {
			const response = await request(base, { method: 'GET', signal }, options);
			if (!response.ok) throw await failureFromResponse(response);
			return ((await response.json()) as { interface: ProfileInterface }).interface;
		},
		turn: ({ replay: _replay, ...body }, onEvent, signal) =>
			postNdjson(`${base}/turn`, body, onEvent, { ...options, signal }),
		invoke: ({ replay: _replay, ...body }, onEvent, signal) =>
			postNdjson(`${base}/invoke`, body, onEvent, { ...options, signal }),
		async steer(body) {
			await postJson(`${base}/steer`, body, options);
		},
	};
}
