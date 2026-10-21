import {
  type GateReference,
  gateReferenceSchema,
  TOOL_GATE_KINDS,
  type ToolGate,
} from '@theoremjs/agents';
import type { PageDispatchResult } from './page-dispatch.ts';
/**
 * Transport contract between a Theorem chat UI and the host that runs turns.
 *
 * The browser never holds the profile: it asks the transport to `describe` the
 * profile's client-safe interface, then streams turns / tool invokes through it.
 * `createHttpTransport` speaks to `createTheoremHandler` (`@theoremjs/web/server`);
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
  turnEventSchema,
  turnHistoryMessageSchema,
  turnToolSnapshotSchema,
  z,
} from '@theoremjs/agents';
import {
  type ErrorCopies,
  errorCopiesSchema,
  kindOfHttpStatus,
} from '@theoremjs/agents/guardrails';
import {
  type ProfileInterface,
  profileInterfaceSchema,
  type TranscriptBlock,
} from '@theoremjs/agents/interface';
import type { Equals } from '@theoremjs/agents/kernel';
import type { PagePart } from './tool-resume.ts';
import type { TraceFeed } from './trace-feed.ts';
import { transcriptBlockSchema } from './transcript-schema.ts';
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
  /** The value chosen for each of the profile's `inputs.slots`. */
  slots?: Record<string, string>;
  /** What the page wants the agent to know: any JSON. The host reads it as untrusted. */
  context?: unknown;
};
const theoremTurnInput = z.object({
  slots: z.record(z.string(), z.string()).optional(),
  context: z.unknown().optional(),
  text: z.string().optional(),
  attachments: z.array(encodedBlob).optional(),
  voice: z.array(encodedBlob).optional(),
});
true satisfies Equals<z.infer<typeof theoremTurnInput>, TheoremTurnInput>;

/**
 * State only the client holds, for hosts whose profile also lives in the browser
 * (the studio). `createHttpTransport` never sends it: `createTheoremHandler`
 * keeps permissions, paused calls, and tool snapshots in its own session.
 */
export type TheoremReplay = {
  gateKind?: ToolGate['kind'];
  sessionPermissions?: string[];
  name?: string;
  input?: unknown;
  snapshot?: TurnToolSnapshot;
  promoted?: string[];
  model?: string;
  effort?: string;
};
const theoremReplay = z.object({
  gateKind: z.enum(TOOL_GATE_KINDS).optional(),
  sessionPermissions: z.array(z.string()).optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  snapshot: turnToolSnapshotSchema.optional(),
  promoted: z.array(z.string()).optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
});
true satisfies Equals<z.infer<typeof theoremReplay>, TheoremReplay>;
/** For a host that reads the studio's client-held state. */
export const theoremReplaySchema: z.ZodType<TheoremReplay> = theoremReplay;

/** An id the client made: trimmed, never blank. */
const clientId = z.string().trim().min(1);

/**
 * One message. The host resolves the profile and owns the conversation: the
 * client sends only the message and the ref of the conversation it continues.
 *
 * A message sent while the reply waits on gates walks away from them: `abandon`
 * names the waiting calls. The host settles each one cancelled, streams those
 * events first, and gives the model each call's answer before the message.
 */
export type TheoremTurnRequest = {
  input: TheoremTurnInput;
  /** The ref of the conversation this message continues; none starts one. */
  conversation?: string;
  model?: string;
  effort?: string;
  /** Client-generated id so mid-turn steers can find this turn's inbox. */
  turnId?: string;
  /** invariant: Both issued IDs identify each paused action that this message abandons. */
  abandon?: GateReference[];
  /** The tools the person allowed for the page, for a host without a session (the studio). */
  replay?: Pick<TheoremReplay, 'sessionPermissions'>;
  /**
   * The page's transcript before this message, sent only after the host answered that it can no
   * longer open `conversation` (`session.conversation_unknown`). A host that restores from it (the
   * studio) goes on from it under a new ref; `createTheoremHandler` keeps the conversation its own
   * and does not.
   */
  transcript?: TranscriptBlock[];
};
const theoremTurnRequest = z.object({
  input: theoremTurnInput,
  conversation: z.string().min(1).optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  turnId: clientId.optional(),
  abandon: z.array(gateReferenceSchema).min(1).optional(),
  replay: theoremReplay.pick({ sessionPermissions: true }).optional(),
  transcript: z.array(transcriptBlockSchema).optional(),
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
  operationId: string;
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
  /** The page's answer to a `page` gate, only with `approve`: the tool's output schema checks it. */
  page?: PagePart;
  /** The ref of the conversation whose reply waits on the gate. */
  conversation?: string;
  /** Client-generated id so steers sent while the reply goes on find its inbox. */
  turnId?: string;
  replay?: TheoremReplay;
};
const pagePart = z.union([
  z.strictObject({ unanswered: z.literal(true) }),
  z
    .strictObject({ output: z.unknown() })
    .refine((part) => 'output' in part)
    .transform((part) => ({ output: part.output })),
]);
const theoremInvokeRequest = z.object({
  gateId: z.string().min(1),
  operationId: z.string().min(1).max(256),
  decision: z.enum(INVOKE_DECISIONS),
  input: z.unknown().optional(),
  secret: z.string().optional(),
  page: pagePart.optional(),
  conversation: z.string().min(1).optional(),
  turnId: clientId.optional(),
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

/** Stop an in-flight turn where it stands; its stream ends with what the reply left. */
export type TheoremStopRequest = { turnId: string };
const theoremStopRequest = z.object({ turnId: clientId });
true satisfies Equals<z.infer<typeof theoremStopRequest>, TheoremStopRequest>;
/** A `/stop` body as `createTheoremHandler` reads it. */
export const theoremStopRequestSchema: z.ZodType<TheoremStopRequest> = theoremStopRequest;

/**
 * The ref the store issued for the conversation a run wrote: the client sends
 * it with its next request. It comes before the run's error, which ends the stream.
 * `posted` marks the write that holds the person's new message: a run that
 * fails before it leaves the message unsent.
 */
export type ConversationLine = { type: 'conversation'; ref: string; posted?: true };
const conversationLine = z.object({
  type: z.literal('conversation'),
  ref: z.string().min(1),
  posted: z.literal(true).optional(),
});
true satisfies Equals<z.infer<typeof conversationLine>, ConversationLine>;

/** The lines a chat's reply streams: turn events, and the conversation's ref. */
export const CHAT_LINES: WireLines<TurnEvent | ConversationLine> = {
  ...TURN_EVENT_SCHEMAS,
  conversation: conversationLine,
};

/** What the browser draws: the transcript, and the reply that waits on gates. */
export type ConversationView = {
  transcript: TranscriptBlock[];
  /** The reply that waits on gates: its events, and its blocks as the transcript will keep them. */
  paused?: { events: TurnEvent[]; blocks: TranscriptBlock[] };
};
const conversationView = z.object({
  transcript: z.array(transcriptBlockSchema),
  paused: z
    .object({ events: z.array(turnEventSchema), blocks: z.array(transcriptBlockSchema) })
    .optional(),
});
true satisfies Equals<z.infer<typeof conversationView>, ConversationView>;

/** Read a conversation: a `/conversation` body. */
export type TheoremConversationRequest = { conversation: string };
const theoremConversationRequest = z.object({ conversation: z.string().min(1) });
true satisfies Equals<z.infer<typeof theoremConversationRequest>, TheoremConversationRequest>;
/** A `/conversation` body as `createTheoremHandler` reads it. */
export const theoremConversationRequestSchema: z.ZodType<TheoremConversationRequest> =
  theoremConversationRequest;

/**
 * Cut the conversation after transcript block `at` (-1 empties it): a
 * `/rewind` body. A reply waiting on gates is walked away from first.
 */
export type TheoremRewindRequest = { conversation: string; at: number };
const theoremRewindRequest = z.object({
  conversation: z.string().min(1),
  at: z.number().int().min(-1),
});
true satisfies Equals<z.infer<typeof theoremRewindRequest>, TheoremRewindRequest>;
/** A `/rewind` body as `createTheoremHandler` reads it. */
export const theoremRewindRequestSchema: z.ZodType<TheoremRewindRequest> = theoremRewindRequest;

/** Start a conversation on blocks the host wrote, not ran: a `/conversation/start` body. */
export type TheoremStartRequest = { blocks: TranscriptBlock[] };
const theoremStartRequest = z.object({ blocks: z.array(transcriptBlockSchema) });
true satisfies Equals<z.infer<typeof theoremStartRequest>, TheoremStartRequest>;
/** A `/conversation/start` body as a host reads it. */
export const theoremStartRequestSchema: z.ZodType<TheoremStartRequest> = theoremStartRequest;

/** A rewound or started conversation: its new ref, and what the browser draws. */
export type TheoremRewound = { conversation: string; view: ConversationView };
const theoremRewound = z.object({ conversation: z.string().min(1), view: conversationView });
true satisfies Equals<z.infer<typeof theoremRewound>, TheoremRewound>;

/** A turn event, one of a kind this client does not know (`unsupported`), or one that failed its check (`malformed`). */
export type ClientTurnEvent = TurnEvent | UnsupportedEvent | MalformedEvent;

export type TurnEventSink = (event: ClientTurnEvent) => void;

/** A line of a chat's reply: a turn event, or the ref of the conversation it wrote. */
export type ChatLine = ClientTurnEvent | ConversationLine;

export type ChatLineSink = (line: ChatLine) => void;

export interface TheoremTransport {
  /** Client-safe interface for the host's profile (inputs, models, guardrail view). */
  describe(signal?: AbortSignal): Promise<ProfileInterface>;
  turn(request: TheoremTurnRequest, onLine: ChatLineSink, signal?: AbortSignal): Promise<void>;
  invoke(request: TheoremInvokeRequest, onLine: ChatLineSink, signal?: AbortSignal): Promise<void>;
  steer(request: TheoremSteerRequest): Promise<void>;
  /** Stops the turn; refused (`session.turn_ended`) when this host is not running it. */
  stop(request: TheoremStopRequest): Promise<void>;
  /** The conversation under `ref`, as the host shows it. */
  conversation(
    request: TheoremConversationRequest,
    signal?: AbortSignal,
  ): Promise<ConversationView>;
  /** The conversation cut after a transcript block, under the ref the host issued for it. */
  rewind(request: TheoremRewindRequest, signal?: AbortSignal): Promise<TheoremRewound>;
  pageResult?(result: PageDispatchResult, signal?: AbortSignal): Promise<void>;
  /** Trace records the host sends back, when it delivers them (the studio does). */
  traces?: TraceFeed;
}

/**
 * A failure the host reported: its kind, the host's wording when it sent one
 * (the profile's labels, applied on the host), and raw detail when the host
 * exposes it. `clientFailure` words it for the user.
 */
export class TheoremStreamError extends Error {
  readonly kind: ErrorKind;
  readonly publicMessage?: string;
  readonly internalMessage?: string;
  /** The labels key behind `publicMessage`, when the host gave one: what failed, more exactly than `kind`. */
  readonly copy?: ErrorCopies;

  constructor(
    kind: ErrorKind,
    publicMessage?: string,
    internalMessage?: string,
    copy?: ErrorCopies,
  ) {
    super(internalMessage ?? publicMessage ?? kind);
    this.name = 'TheoremStreamError';
    this.kind = kind;
    if (publicMessage) this.publicMessage = publicMessage;
    if (internalMessage) this.internalMessage = internalMessage;
    if (copy) this.copy = copy;
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
export type HostErrorBody = {
  error?: string;
  errorKind?: ErrorKind;
  /** The labels key behind `error`, when more specific than the kind's. */
  errorCopy?: ErrorCopies;
  errorInternal?: string;
};
const hostErrorBody = z.object({
  error: z.string().optional(),
  errorKind: errorKindSchema.optional(),
  errorCopy: errorCopiesSchema.optional(),
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
    body.errorCopy,
  );
}

/** The host could not open the message's conversation (`session.conversation_unknown`). */
export function isUnknownConversation(err: unknown): boolean {
  if (!isTheoremStreamError(err) || err.copy === undefined) return false;
  const copies: readonly { key: string }[] = Array.isArray(err.copy) ? err.copy : [err.copy];
  return copies.some((copy) => copy.key === 'session.conversation_unknown');
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
  if (!response.body) throw new TheoremError('bad_response', 'stream reply has no body'); // labels-exempt: internal diagnostic

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
async function failureFromResponse(
  response: Response,
  failed?: (body: unknown) => void,
): Promise<TheoremError | TheoremStreamError> {
  const text = await response.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
    failed?.(raw);
  } catch {
    return hostError(
      { errorInternal: `HTTP ${String(response.status)}` },
      kindOfHttpStatus(response.status),
    );
  }
  const body = hostErrorBody.safeParse(raw);
  if (!body.success) {
    // labels-exempt: internal diagnostic; the user reads error.bad_response
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
  const response = await jsonPostResponse(url, body, options);
  await readNdjsonStream(response, lines, onLine, options.signal);
}

async function jsonPostResponse(
  url: string,
  body: unknown,
  options: HttpOptions & { signal?: AbortSignal },
): Promise<Response> {
  const response = await request(
    url,
    { method: 'POST', body: JSON.stringify(body), signal: options.signal },
    options,
  );
  if (!response.ok) throw await failureFromResponse(response);
  return response;
}

/** POST JSON; a non-OK reply throws its failure. The OK reply's body is not read. */
export async function postJson(
  url: string,
  body: unknown,
  options: HttpOptions & { signal?: AbortSignal } = {},
): Promise<void> {
  await jsonPostResponse(url, body, options);
}

/**
 * GET, or POST `body` as JSON, and read the JSON reply; a non-OK reply throws its failure, after
 * `failed` has read whatever else its JSON body carries.
 */
export async function fetchJson(
  url: string,
  init: { body?: unknown; signal?: AbortSignal; failed?: (body: unknown) => void },
  options: HttpOptions = {},
): Promise<unknown> {
  const method =
    init.body === undefined
      ? { method: 'GET' }
      : { method: 'POST', body: JSON.stringify(init.body) };
  const response = await request(url, { ...method, signal: init.signal }, options);
  if (!response.ok) throw await failureFromResponse(response, init.failed);
  return parseWireJson(await response.text());
}

/** POST a conversation's read to `url`, and check the view the host answers. */
export async function fetchConversation(
  url: string,
  body: unknown,
  options: HttpOptions & { signal?: AbortSignal } = {},
): Promise<ConversationView> {
  const { signal, ...http } = options;
  // labels-exempt: internal diagnostic; the user reads error.bad_response
  return checkWire(
    conversationView,
    await fetchJson(url, { body, signal }, http),
    'the conversation',
  );
}

async function fetchConversationRef(
  url: string,
  body: unknown,
  options: HttpOptions & { signal?: AbortSignal },
  what: string,
): Promise<TheoremRewound> {
  const { signal, ...http } = options;
  return checkWire(theoremRewound, await fetchJson(url, { body, signal }, http), what);
}

/** POST a rewind to `url`, and check the rewound conversation the host answers. */
export function fetchRewound(
  url: string,
  body: unknown,
  options: HttpOptions & { signal?: AbortSignal } = {},
): Promise<TheoremRewound> {
  // labels-exempt: internal diagnostic; the user reads error.bad_response
  return fetchConversationRef(url, body, options, 'the rewound conversation');
}

/** POST blocks to start a conversation on to `url`, and check the conversation the host answers. */
export function fetchStarted(
  url: string,
  body: unknown,
  options: HttpOptions & { signal?: AbortSignal } = {},
): Promise<TheoremRewound> {
  // labels-exempt: internal diagnostic; the user reads error.bad_response
  return fetchConversationRef(url, body, options, 'the started conversation');
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
      // labels-exempt: internal diagnostic; the user reads error.bad_response
      return checkWire(
        describedSchema,
        parseWireJson(await response.text()),
        'the profile description',
      ).interface;
    },
    turn: ({ replay: _replay, ...body }, onEvent, signal) =>
      postNdjson(`${base}/turn`, body, CHAT_LINES, onEvent, { ...options, signal }),
    invoke: ({ replay: _replay, ...body }, onEvent, signal) =>
      postNdjson(`${base}/invoke`, body, CHAT_LINES, onEvent, { ...options, signal }),
    conversation: (body, signal) =>
      fetchConversation(`${base}/conversation`, body, { ...options, signal }),
    rewind: (body, signal) => fetchRewound(`${base}/rewind`, body, { ...options, signal }),
    pageResult: (body, signal) => postJson(`${base}/page-result`, body, { ...options, signal }),
    steer: (body) => postJson(`${base}/steer`, body, options),
    stop: (body) => postJson(`${base}/stop`, body, options),
  };
}
