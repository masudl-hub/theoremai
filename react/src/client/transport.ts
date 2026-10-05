/**
 * Transport contract between a Theorem chat UI and the host that runs turns.
 *
 * The browser never holds the profile: it asks the transport to `describe` the
 * profile's client-safe interface, then streams turns / tool invokes through it.
 * `createHttpTransport` speaks to `createTheoremHandler` (`@theoremjs/react/server`);
 * hosts with their own wire format implement {@link TheoremTransport} directly.
 *
 * @module
 */

import {
  describeError,
  type ErrorKind,
  errorKindSchema,
  type GateDecision,
  isAbortError,
  TheoremError,
  TURN_EVENT_SCHEMAS,
  type TurnEvent,
  type TurnHistoryMessage,
  type TurnToolSnapshot,
  throwIfAborted,
  turnHistoryMessageSchema,
  turnToolSnapshotSchema,
  z,
} from '@theoremjs/agents';
import { kindOfHttpStatus } from '@theoremjs/agents/guardrails';
import { type ProfileInterface, profileInterfaceSchema } from '@theoremjs/agents/interface';
import type { Equals } from '@theoremjs/agents/kernel';
import type { TraceFeed } from './trace-feed.ts';
import {
  checkWire,
  type MalformedEvent,
  parseWireJson,
  readWireLine,
  type UnsupportedEvent,
  type WireLines,
} from './wire-line.ts';

export type { MalformedEvent, UnsupportedEvent, WireLines } from './wire-line.ts';

export type EncodedBlob = { name: string; mimeType: string; data: string };
const encodedBlob = z.object({ name: z.string(), mimeType: z.string(), data: z.string() });
true satisfies Equals<z.infer<typeof encodedBlob>, EncodedBlob>;

/** Turn input as sent over the wire (media is base64-encoded). */
export type TheoremTurnInput = {
  text?: string;
  attachments?: EncodedBlob[];
  voice?: EncodedBlob[];
  history?: TurnHistoryMessage[];
  historyTokens?: number;
  inputTokens?: number;
};
const theoremTurnInput = z.object({
  text: z.string().optional(),
  attachments: z.array(encodedBlob).optional(),
  voice: z.array(encodedBlob).optional(),
  history: z.array(turnHistoryMessageSchema).optional(),
  historyTokens: z.number().optional(),
  inputTokens: z.number().optional(),
});
true satisfies Equals<z.infer<typeof theoremTurnInput>, TheoremTurnInput>;

/**
 * State only the client holds, for hosts whose profile also lives in the browser
 * (the playground). `createHttpTransport` never sends it: `createTheoremHandler`
 * keeps permissions, paused calls, and tool snapshots in its own session.
 */
export type TheoremReplay = {
  sessionPermissions?: string[];
  name?: string;
  input?: unknown;
  turnInput?: TheoremTurnInput;
  snapshot?: TurnToolSnapshot;
  promoted?: string[];
  model?: string;
  effort?: string;
  path?: string;
};
const theoremReplay = z.object({
  sessionPermissions: z.array(z.string()).optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  turnInput: theoremTurnInput.optional(),
  snapshot: turnToolSnapshotSchema.optional(),
  promoted: z.array(z.string()).optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  path: z.string().optional(),
});
true satisfies Equals<z.infer<typeof theoremReplay>, TheoremReplay>;
/** For a host that reads the playground's client-held state. */
export const theoremReplaySchema: z.ZodType<TheoremReplay> = theoremReplay;

/** An id the client made: trimmed, never blank. */
const clientId = z.string().trim().min(1);

/**
 * One text turn. The host resolves the profile; the client sends the conversation.
 *
 * A message sent while the reply waits on gates walks away from them: `abandon`
 * names the waiting calls, and `input.history` ends on their step with those
 * calls open. The host settles each one cancelled, streams those events first,
 * and gives the model each call's answer before the message.
 */
export type TheoremTurnRequest = {
  input: TheoremTurnInput;
  previousInteractionId?: string;
  model?: string;
  effort?: string;
  /** Client-generated id so mid-turn steers can find this turn's inbox. */
  turnId?: string;
  /** Call ids of the paused calls this message walks away from. */
  abandon?: string[];
  replay?: Pick<TheoremReplay, 'sessionPermissions'> & {
    /** Each walked-away call as the client holds it, by call id, for a host without a session. */
    abandon?: Record<string, TheoremReplay>;
  };
};
const theoremTurnRequest = z.object({
  input: theoremTurnInput,
  previousInteractionId: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  turnId: clientId.optional(),
  abandon: z.array(z.string().min(1)).min(1).optional(),
  replay: theoremReplay
    .pick({ sessionPermissions: true })
    .extend({ abandon: z.record(z.string(), theoremReplay).optional() })
    .optional(),
});
true satisfies Equals<z.infer<typeof theoremTurnRequest>, TheoremTurnRequest>;
/** A `/turn` body as `createTheoremHandler` reads it. */
export const theoremTurnRequestSchema: z.ZodType<TheoremTurnRequest> = theoremTurnRequest;

/** What the user answers a gate with; walking away rides on the next message (`TheoremTurnRequest.abandon`). */
const INVOKE_DECISIONS = ['approve', 'deny'] as const satisfies readonly GateDecision[];

/**
 * The user's answer to a tool call the host paused on a gate. `approve` runs it
 * (with `input` when the user edited it); `deny` refuses it. The host settles
 * each one, so the model and the trace read what the user chose. The tool's
 * registered permission decides how long an approval lasts, not the client.
 */
export type TheoremInvokeRequest = {
  /** Call id of the paused tool call (`tool.callId` on its gate event). */
  gateId: string;
  decision: (typeof INVOKE_DECISIONS)[number];
  /** The user's edit of the model's input; only with `approve`. */
  input?: unknown;
  /**
   * The key or token the user typed at a bearer or API-key sign-in gate, only
   * with `approve`. The server saves it for the session and never sends it
   * back; an OAuth gate resumes with the gate id alone, once the host's
   * callback saved the token.
   */
  secret?: string;
  replay?: TheoremReplay;
};
const theoremInvokeRequest = z.object({
  gateId: z.string().min(1),
  decision: z.enum(INVOKE_DECISIONS),
  input: z.unknown().optional(),
  secret: z.string().optional(),
  replay: theoremReplay.optional(),
});
true satisfies Equals<z.infer<typeof theoremInvokeRequest>, TheoremInvokeRequest>;
/** An `/invoke` body as `createTheoremHandler` reads it. */
export const theoremInvokeRequestSchema: z.ZodType<TheoremInvokeRequest> = theoremInvokeRequest;

/** Inject user messages into an in-flight turn. */
export type TheoremSteerRequest = {
  turnId: string;
  /** The client's id for this steer; the turn's `stage` event names it in `injected` once it lands. */
  id: string;
  inject: TurnHistoryMessage[];
};
const theoremSteerRequest = z.object({
  turnId: clientId,
  id: clientId,
  inject: z.array(turnHistoryMessageSchema).min(1),
});
true satisfies Equals<z.infer<typeof theoremSteerRequest>, TheoremSteerRequest>;
/** A `/steer` body as `createTheoremHandler` reads it. */
export const theoremSteerRequestSchema: z.ZodType<TheoremSteerRequest> = theoremSteerRequest;

/** A turn event, one of a kind this client does not know (`unsupported`), or one that failed its check (`malformed`). */
export type ClientTurnEvent = TurnEvent | UnsupportedEvent | MalformedEvent;

export type TurnEventSink = (event: ClientTurnEvent) => void;

export interface TheoremTransport {
  /** Client-safe interface for the host's profile (inputs, models, guardrail view). */
  describe(signal?: AbortSignal): Promise<ProfileInterface>;
  turn(request: TheoremTurnRequest, onEvent: TurnEventSink, signal?: AbortSignal): Promise<void>;
  invoke(
    request: TheoremInvokeRequest,
    onEvent: TurnEventSink,
    signal?: AbortSignal,
  ): Promise<void>;
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
function textOf(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/** A host error reply's body (JSON reply or `{ type: 'error' }` stream line). */
export type HostErrorBody = { error?: string; errorKind?: ErrorKind; errorInternal?: string };
const hostErrorBody = z.object({
  error: z.string().optional(),
  errorKind: errorKindSchema.optional(),
  errorInternal: z.string().optional(),
});
true satisfies Equals<z.infer<typeof hostErrorBody>, HostErrorBody>;
/** A host's error body, as the transport and the live client read it. */
export const hostErrorBodySchema: z.ZodType<HostErrorBody> = hostErrorBody;

/** A host's error body as a failure: its kind (else `fallbackKind`), wording, and detail. */
export function hostError(body: HostErrorBody, fallbackKind: ErrorKind): TheoremStreamError {
  const publicMessage = textOf(body.error);
  const internal = textOf(body.errorInternal);
  return new TheoremStreamError(
    body.errorKind ?? fallbackKind,
    publicMessage,
    internal && internal !== publicMessage ? internal : undefined,
  );
}

/** One NDJSON line checked against `lines`; an `error` line ends the stream as a {@link TheoremStreamError}. */
function parseStreamLine<Line extends { type: string }>(
  lines: WireLines<Line>,
  text: string,
): Line | UnsupportedEvent | MalformedEvent {
  const line = readWireLine(lines, text);
  // why: An `error` line passed the error event's schema, whose fields include the body's.
  if (line.type === 'error') throw hostError(hostErrorBody.parse(line), 'internal');
  return line;
}

function flushNdjsonChunk<Line extends { type: string }>(
  buffer: string,
  lines: WireLines<Line>,
  onLine: (line: Line | UnsupportedEvent | MalformedEvent) => void,
): string {
  const chunks = buffer.split('\n');
  const rest = chunks.pop() ?? '';
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    onLine(parseStreamLine(lines, chunk));
  }
  return rest;
}

/**
 * Read an NDJSON reply, checking each line against `lines`: a kind it doesn't
 * list reaches `onLine` as `unsupported`, and a line that fails its check as
 * `malformed`; the stream goes on. An `error` line ends it.
 */
export async function readNdjsonStream<Line extends { type: string }>(
  response: Response,
  lines: WireLines<Line>,
  onLine: (line: Line | UnsupportedEvent | MalformedEvent) => void,
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
      buffer = flushNdjsonChunk(buffer + decoder.decode(value, { stream: true }), lines, onLine);
    }
    const tail = buffer.trim();
    if (tail) onLine(parseStreamLine(lines, tail));
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

/**
 * A non-OK reply as a failure: the host's kind and wording, else the status's
 * kind. A body that is not JSON (a proxy's page) leaves the status to speak; a
 * JSON body that fails the error body's schema is `bad_response`.
 */
async function failureFromResponse(response: Response): Promise<TheoremError | TheoremStreamError> {
  const text = await response.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return hostError(
      { errorInternal: `HTTP ${String(response.status)}` },
      kindOfHttpStatus(response.status),
    );
  }
  const body = hostErrorBody.safeParse(raw);
  if (!body.success) {
    // lexicon-exempt: internal diagnostic; the user reads error.bad_response
    return new TheoremError(
      'bad_response',
      `HTTP ${String(response.status)} error body failed its wire check`,
    );
  }
  return hostError(
    { ...body.data, errorInternal: body.data.errorInternal ?? `HTTP ${String(response.status)}` },
    kindOfHttpStatus(response.status),
  );
}

async function request(url: string, init: RequestInit, options: HttpOptions): Promise<Response> {
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

/**
 * POST JSON and stream NDJSON lines back, each checked against `lines`: turn
 * events ({@link TURN_EVENT_SCHEMAS}), or a host's own schema beside them.
 */
export async function postNdjson<Line extends { type: string }>(
  url: string,
  body: unknown,
  lines: WireLines<Line>,
  onLine: (line: Line | UnsupportedEvent | MalformedEvent) => void,
  options: HttpOptions & { signal?: AbortSignal } = {},
): Promise<void> {
  const response = await request(
    url,
    { method: 'POST', body: JSON.stringify(body), signal: options.signal },
    options,
  );
  if (!response.ok) throw await failureFromResponse(response);
  await readNdjsonStream(response, lines, onLine, options.signal);
}

/** POST JSON; a non-OK reply throws its failure. The OK reply's body is not read. */
export async function postJson(
  url: string,
  body: unknown,
  options: HttpOptions = {},
): Promise<void> {
  const response = await request(url, { method: 'POST', body: JSON.stringify(body) }, options);
  if (!response.ok) throw await failureFromResponse(response);
}

/** GET, or POST `body` as JSON, and read the JSON reply; a non-OK reply throws its failure. */
export async function fetchJson(
  url: string,
  init: { body?: unknown; signal?: AbortSignal },
  options: HttpOptions = {},
): Promise<unknown> {
  const method =
    init.body === undefined
      ? { method: 'GET' }
      : { method: 'POST', body: JSON.stringify(init.body) };
  const response = await request(url, { ...method, signal: init.signal }, options);
  if (!response.ok) throw await failureFromResponse(response);
  return parseWireJson(await response.text());
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

/** The host's `describe` reply. */
const describedSchema = z.object({ interface: profileInterfaceSchema });

/** Transport for a host mounted with `createTheoremHandler`. */
export function createHttpTransport(options: HttpTransportOptions = {}): TheoremTransport {
  const base = withoutTrailingSlashes(options.endpoint ?? '/api/theorem');
  return {
    async describe(signal) {
      const response = await request(base, { method: 'GET', signal }, options);
      if (!response.ok) throw await failureFromResponse(response);
      // lexicon-exempt: internal diagnostic; the user reads error.bad_response
      return checkWire(
        describedSchema,
        parseWireJson(await response.text()),
        'the profile description',
      ).interface;
    },
    turn: ({ replay: _replay, ...body }, onEvent, signal) =>
      postNdjson(`${base}/turn`, body, TURN_EVENT_SCHEMAS, onEvent, { ...options, signal }),
    invoke: ({ replay: _replay, ...body }, onEvent, signal) =>
      postNdjson(`${base}/invoke`, body, TURN_EVENT_SCHEMAS, onEvent, { ...options, signal }),
    steer: (body) => postJson(`${base}/steer`, body, options),
  };
}
