import { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import { labelText } from '../../guardrails/labels.ts';
import type { JsonObject, JsonValue } from '../json.ts';
import type { ProfileType } from '../schema.ts';
import type { ReasoningOrigin, ToolCallRequest } from '../turn-events.ts';
import type {
  DecisionRequest,
  DecisionResult,
  EmbeddingInput,
  EmbeddingResult,
  EmbeddingTask,
  InteractionPart,
  ModelRequest,
  TurnContext,
  TurnEvent,
  TurnHistoryMessage,
  TurnResponse,
  TurnStop,
} from '../types.ts';
import type { ProviderLimits } from './limits.ts';

/** The kinds of profile a protocol can serve, each at its own endpoint: every type but `host`. */
const MODEL_PROFILE_TYPES = [
  'text',
  'image',
  'speech',
  'live',
  'decision',
  'embedding',
] as const satisfies readonly Exclude<ProfileType, 'host'>[];
export type ModelProfileType = (typeof MODEL_PROFILE_TYPES)[number];

/** The turn events a protocol yields as they are. */
export type ProtocolContentEvent = Extract<
  TurnEvent,
  {
    type:
      | 'text'
      | 'thought'
      | 'structured'
      | 'media'
      | 'grounding'
      | 'citation'
      | 'evidence'
      | 'tokens'
      | 'session'
      | 'tool_draft'
      | 'error';
  }
>;

/**
 * What a protocol streams back: the model's events, reasoning it must get back word for word,
 * content with no common shape, and (opted in) the wire rows themselves. A protocol writes
 * `custom.kind` in its own terms; the kernel sets reasoning's origin and mints call ids.
 */
export type ProtocolEvent<S = unknown> =
  | ProtocolContentEvent
  | { type: 'tool_call'; call: ToolCallRequest & { wireCallId?: string } }
  | { type: 'tool_cancel'; callId: string }
  | { type: 'response'; response: TurnResponse }
  | { type: 'done'; stop: TurnStop; interrupted?: boolean; state?: S }
  | { type: 'reasoning'; text?: string; data: JsonValue; origin?: ReasoningOrigin }
  | { type: 'custom'; kind: string; data: JsonObject }
  | { type: 'raw'; row: JsonObject };

/**
 * One turn as a protocol gets it: the kernel's request without what only the kernel uses (the
 * checkpoint, the upstream tap), and the protocol's own saved state, if it is reused.
 */
export type ProtocolRequest<S = unknown> = Omit<ModelRequest, 'providerState' | 'tapUpstream'> & {
  state?: S;
  /** How much of `history` the reused state already holds. */
  stateHistoryLength?: number;
};

export type DecisionCall = Pick<DecisionRequest, 'state' | 'questions'> & {
  apiId: string;
  signal?: AbortSignal;
};

/** One embedding request after profile resolution, before provider serialization. */
export type EmbeddingCall = {
  apiId: string;
  input: EmbeddingInput | readonly EmbeddingInput[];
  task?: EmbeddingTask;
  options?: JsonObject;
  signal?: AbortSignal;
};

export type { EmbeddingResult };

/** A tool's result, sent back into a live session. */
export interface LiveToolResult {
  callId: string;
  name: string;
  text: string;
  parts?: InteractionPart[];
}

/** A live session, as a protocol hands it back. */
export interface ProtocolSession<S = unknown> {
  closeInfo?():
    | {
        code: number;
        reason: string;
        error?: Error;
        warning?: { timeLeftMs?: number; closedAfterMs: number };
      }
    | undefined;
  events(): AsyncIterable<ProtocolEvent<S>>;
  sendText(text: string): Promise<void>;
  sendAudio(media: { data: string; mimeType: string }): Promise<void>;
  sendVideo(media: { data: string; mimeType: string }): Promise<void>;
  sendContext(context: TurnContext): Promise<void>;
  sendToolResult(result: LiveToolResult): Promise<void>;
  close(reason?: string): Promise<void>;
}

/** One open WebSocket: frames out and in are JSON objects. */
export interface ProtocolSocket {
  /** `input` is what the frame gives the model to read, for the trace; setup and control frames give none. */
  send(frame: JsonObject, input?: readonly TurnHistoryMessage[]): void;
  frames(): AsyncIterable<JsonObject>;
  close(code?: number, reason?: string): void;
}

export interface SendInit {
  stream: boolean;
  /** In place of the profile type's endpoint, for a call the shape makes elsewhere. */
  path?: string;
  headers?: Record<string, string>;
  /** The builtin ids this request wrote. Any other id the request asked for is refused. */
  wroteTools?: readonly string[];
}

/** What the kernel hands a protocol for one call. It never holds a key, a slot or a base URL. */
export interface ProtocolContext<O = unknown> {
  profileType: ModelProfileType;
  apiId: string;
  options: O;
  /** The binding's `builtInTools`, for the protocol to write. */
  builtInTools: readonly string[];
  limits: ProviderLimits;
  signal?: AbortSignal;
  /** Posts to this profile type's endpoint on the provider and yields the reply's rows. */
  send(body: JsonObject, init: SendInit): AsyncIterable<JsonObject>;
  /** Opens this profile type's WebSocket on the provider and sends `setup` as the first frame. */
  connect(setup: JsonObject, init?: { wroteTools?: readonly string[] }): Promise<ProtocolSocket>;
  tapUpstream(row: JsonObject): void;
}

export interface ProtocolOperations<S = unknown> {
  complete?(request: ProtocolRequest<S>): AsyncIterable<ProtocolEvent<S>>;
  openSession?(request: ProtocolRequest<S>): Promise<ProtocolSession<S>>;
  decide?(request: DecisionCall): Promise<DecisionResult>;
  embed?(request: EmbeddingCall): Promise<EmbeddingResult>;
}

/** An upstream answer that was not a success, for the protocol to type. */
export interface UpstreamFailure {
  status: number;
  body: JsonValue;
  headers: Headers;
}

export interface Continuation<S> {
  version: number;
  schema: z.ZodType<S>;
  /** Options that change what saved state means; a checkpoint is reused only when they match. */
  keyOptions?: readonly string[];
}

/** One kind of media an embedding model takes: its MIME types, and how many one input may hold when the provider caps it. */
export interface EmbeddingMediaKind {
  accept: readonly string[];
  maxPerInput?: number;
}

/** What one embedding model takes, as its provider documents it. */
export interface EmbeddingModelLimits {
  /** Inputs one request may carry, when the provider caps them. */
  maxInputs?: number;
  /** The media it embeds; empty for a model that embeds text only. */
  media: readonly EmbeddingMediaKind[];
}

export interface ProtocolDefinition<O = unknown, S = unknown> {
  /** What bindings write, e.g. `'openAi'`. */
  id: string;
  /** What people read, e.g. `'OpenAI Chat Completions'`. */
  name: string;
  /** One sentence, for the studio and docs. */
  description: string;
  /** The path each profile type uses. A type with no entry is not served. */
  endpoints: Partial<Record<ModelProfileType, string>>;
  /** Every field a binding may set, each described. */
  options: z.ZodType<O>;
  continuation?: Continuation<S>;
  /** The `data` of the reasoning parts it writes. */
  reasoning?: z.ZodType<JsonValue>;
  /** Content it emits that has no common shape, by kind. */
  custom?: Readonly<Record<string, z.ZodType<JsonObject>>>;
  /**
   * Turns the reply's framing into rows. Absent: SSE for a stream, one JSON row otherwise, and a
   * body that is not JSON as one `{ eventType: 'http_body', mime_type, data }` row, base64.
   */
  framing?(response: Response, stream: boolean): AsyncIterable<JsonObject>;
  /** Types a failed answer. Absent: the kind follows the HTTP status. */
  error?(failure: UpstreamFailure): TheoremError;
  /** What the named embedding model takes. Absent: the kernel holds requests to the profile alone. */
  embeddingLimits?(apiId: string): EmbeddingModelLimits;
  create(context: ProtocolContext<O>): ProtocolOperations<S>;
}

/** A defined protocol. `lineage` is its id, then its base's, back to the first. */
export interface Protocol<O = unknown, S = unknown>
  extends Readonly<Omit<ProtocolDefinition<O, S>, 'create'>> {
  readonly base?: Protocol;
  readonly lineage: readonly string[];
  create(context: ProtocolContext<O>): ProtocolOperations<S>;
}

const definitionShape = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  endpoints: z.partialRecord(z.enum(MODEL_PROFILE_TYPES), z.string().min(1)),
});

function refuse(id: string, issues: string): TheoremError {
  return new TheoremError('config', labelText('protocol.definition', { id, issues }));
}

function checkShape(definition: { id: string } & Record<string, unknown>): void {
  const parsed = definitionShape.safeParse(definition);
  if (!parsed.success) throw refuse(String(definition.id), z.prettifyError(parsed.error));
}

function own<T>(
  protocol: { id: string },
  kind: string,
  schema: z.ZodType<T> | undefined,
  value: unknown,
): T {
  if (!schema)
    throw new TheoremError(
      'internal',
      labelText('protocol.part_schema', { protocol: protocol.id, kind }),
    );
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new TheoremError(
      'bad_response',
      labelText('protocol.part_invalid', { protocol: protocol.id, kind }),
      {
        cause: parsed.error,
      },
    );
  return parsed.data;
}

type Writer = Pick<ProtocolDefinition, 'id' | 'reasoning' | 'custom'>;

/**
 * Marks an event a protocol wrote as its own: reasoning gets its origin, a custom kind its
 * protocol prefix. Each is checked against the writer's schema.
 */
function stamp<S>(writer: Writer, event: ProtocolEvent<S>): ProtocolEvent<S> {
  if (event.type === 'reasoning')
    return {
      ...event,
      data: own(writer, 'reasoning', writer.reasoning, event.data),
      origin: { protocol: writer.id },
    };
  if (event.type === 'custom')
    return {
      type: 'custom',
      kind: `${writer.id}.${event.kind}`,
      data: own(writer, event.kind, writer.custom?.[event.kind], event.data),
    };
  return event;
}

async function* stamped<S>(writer: Writer, events: AsyncIterable<ProtocolEvent<S>>) {
  for await (const event of events) yield stamp(writer, event);
}

function stampOperations<S>(
  writer: Writer,
  operations: ProtocolOperations<S>,
): ProtocolOperations<S> {
  const { complete, openSession } = operations;
  return {
    ...operations,
    ...(complete
      ? { complete: (request) => stamped(writer, complete.call(operations, request)) }
      : {}),
    ...(openSession
      ? {
          async openSession(request) {
            const session = await openSession.call(operations, request);
            return { ...session, events: () => stamped(writer, session.events()) };
          },
        }
      : {}),
  };
}

/** Defines a protocol: the code that speaks one API shape, and everything on its wire. */
export function defineProtocol<O, S = unknown>(
  definition: ProtocolDefinition<O, S>,
): Protocol<O, S> {
  checkShape(definition as unknown as { id: string } & Record<string, unknown>);
  if (
    typeof definition.create !== 'function' ||
    typeof definition.options?.safeParse !== 'function'
  )
    // labels-exempt: builder diagnostic
    throw refuse(definition.id, 'create and options are required');
  return Object.freeze({
    ...definition,
    lineage: Object.freeze([definition.id]),
    create: (context: ProtocolContext<O>) =>
      stampOperations(definition, definition.create(context)),
  });
}

/** What an extension's `body` sees. */
export interface ExtensionBodyAt<E> {
  profileType: ModelProfileType;
  apiId: string;
  options: E;
  /** The binding's built-in tool ids. */
  builtInTools: readonly string[];
  /** The request's headers, to add to. */
  headers: Headers;
  /** The turn being sent; absent for a decision and a live session's later frames. */
  request?: ProtocolRequest<unknown>;
}

/** What an extension's reader keeps for one call: it sees each reply row before the base. */
export interface ExtensionReader<S = unknown> {
  row(row: JsonObject): { events?: ProtocolEvent<S>[]; consumed?: boolean };
  finish?(): { events?: ProtocolEvent<S>[] };
}

export interface ProtocolExtension<E = unknown, S = unknown>
  extends Pick<
    ProtocolDefinition<E, S>,
    'id' | 'name' | 'description' | 'reasoning' | 'custom' | 'framing' | 'error' | 'embeddingLimits'
  > {
  /** What it adds to the base's options. A field the base already has is refused. */
  options?: z.ZodObject & z.ZodType<E>;
  /** Its own paths, where they differ from the base's. */
  endpoints?: Partial<Record<ModelProfileType, string>>;
  /** What it adds to the base's request (or a WebSocket's first frame), and the tools it wrote. */
  body?(
    body: JsonObject,
    at: ExtensionBodyAt<E>,
  ): { body: JsonObject; wroteTools?: readonly string[] };
  /** One per call: reads each reply row before the base. */
  read?(at: {
    profileType: ModelProfileType;
    apiId: string;
    options: E;
    request?: ProtocolRequest<unknown>;
  }): ExtensionReader<S>;
}

function shapeOf(schema: z.ZodType): Record<string, z.ZodType> | undefined {
  return schema instanceof z.ZodObject ? (schema.shape as Record<string, z.ZodType>) : undefined;
}

function pick(value: unknown, keys: readonly string[]): JsonObject {
  const source = (value ?? {}) as JsonObject;
  const out: JsonObject = {};
  for (const key of keys) if (key in source) out[key] = source[key] as JsonValue;
  return out;
}

interface MergedOptions<O, E> {
  schema: z.ZodType<O & E>;
  baseKeys: readonly string[] | undefined;
  addedKeys: readonly string[];
}

function mergeOptions<O, E>(
  base: Protocol<O>,
  extension: ProtocolExtension<E>,
): MergedOptions<O, E> {
  const baseShape = shapeOf(base.options);
  const addedShape = extension.options ? shapeOf(extension.options) : {};
  if (extension.options && !baseShape)
    throw new TheoremError(
      'config',
      labelText('protocol.base_options', { protocol: extension.id, base: base.id }),
    );
  for (const option of Object.keys(addedShape ?? {}))
    if (baseShape && option in baseShape)
      throw new TheoremError(
        'config',
        labelText('protocol.option_clash', { protocol: extension.id, option, base: base.id }),
      );
  return {
    schema: (baseShape
      ? z.strictObject({ ...baseShape, ...addedShape })
      : base.options) as unknown as z.ZodType<O & E>,
    baseKeys: baseShape ? Object.keys(baseShape) : undefined,
    addedKeys: Object.keys(addedShape ?? {}),
  };
}

interface ExtendedCall<S> {
  operations: ProtocolOperations<S>;
  drained(events: AsyncIterable<ProtocolEvent<S>>): AsyncIterable<ProtocolEvent<S>>;
}

/** One call through the extension: its body goes on what the base sends, its reader sees each row first. */
function extendedCall<O, S, E>(
  base: Protocol<O, S>,
  extension: ProtocolExtension<E, S>,
  keys: MergedOptions<O, E>,
  context: ProtocolContext<O & E>,
  request?: ProtocolRequest<S>,
): ExtendedCall<S> {
  const at = {
    profileType: context.profileType,
    apiId: context.apiId,
    options: pick(context.options, keys.addedKeys) as E,
  };
  const pending: ProtocolEvent<S>[] = [];
  const reader = extension.read?.({
    ...at,
    ...(request ? { request: request as ProtocolRequest<unknown> } : {}),
  });
  const take = (events: ProtocolEvent<S>[] | undefined) => {
    for (const event of events ?? []) pending.push(stamp(extension, event));
  };
  const rewrite = (body: JsonObject, headers: Headers, wrote: readonly string[] = []) => {
    if (!extension.body) return { body, wroteTools: wrote };
    const out = extension.body(body, {
      ...at,
      builtInTools: context.builtInTools,
      headers,
      ...(request ? { request: request as ProtocolRequest<unknown> } : {}),
    });
    return { body: out.body, wroteTools: [...wrote, ...(out.wroteTools ?? [])] };
  };
  async function* read(rows: AsyncIterable<JsonObject>) {
    for await (const row of rows) {
      const seen = reader?.row(row);
      take(seen?.events);
      if (!seen?.consumed) yield row;
    }
  }
  const inner: ProtocolContext<O> = {
    ...context,
    options: (keys.baseKeys ? pick(context.options, keys.baseKeys) : context.options) as O,
    send(body, init) {
      const headers = new Headers(init.headers);
      const out = rewrite(body, headers, init.wroteTools);
      return read(
        context.send(out.body, {
          ...init,
          headers: Object.fromEntries(headers),
          wroteTools: out.wroteTools,
        }),
      );
    },
    async connect(setup, init) {
      const out = rewrite(setup, new Headers(), init?.wroteTools);
      const socket = await context.connect(out.body, { wroteTools: out.wroteTools });
      return { ...socket, frames: () => read(socket.frames()) };
    },
  };
  async function* drained(events: AsyncIterable<ProtocolEvent<S>>) {
    for await (const event of events) {
      yield* pending.splice(0);
      if (event.type === 'done') take(reader?.finish?.().events);
      yield* pending.splice(0);
      yield event;
    }
    yield* pending.splice(0);
  }
  return { operations: base.create(inner), drained };
}

/** The operations the base offers, each run as a fresh extended call. */
function extendedOperations<S>(
  call: (request?: ProtocolRequest<S>) => ExtendedCall<S>,
): ProtocolOperations<S> {
  // invariant: Each call gets its own reader and pending events; the first only says which operations the base has.
  const offered = call().operations;
  type Ops = Required<ProtocolOperations<S>>;
  const operations: ProtocolOperations<S> = {};
  if (offered.complete)
    operations.complete = (request) => {
      const { operations, drained } = call(request);
      return drained((operations.complete as Ops['complete'])(request));
    };
  if (offered.openSession)
    operations.openSession = async (request) => {
      const { operations, drained } = call(request);
      const session = await (operations.openSession as Ops['openSession'])(request);
      return { ...session, events: () => drained(session.events()) };
    };
  if (offered.decide)
    operations.decide = (request) => (call().operations.decide as Ops['decide'])(request);
  if (offered.embed)
    operations.embed = (request) => (call().operations.embed as Ops['embed'])(request);
  return operations;
}

/** The extension's own value for a field, else the base's; absent when neither has one. */
function either<K extends 'framing' | 'error' | 'embeddingLimits'>(
  key: K,
  extension: Partial<Record<K, unknown>>,
  base: Partial<Record<K, unknown>>,
) {
  const value = extension[key] ?? base[key];
  return value ? { [key]: value } : {};
}

/**
 * A new protocol built on a base it nearly matches. It has its own id, so what it sends has one
 * answer: its definition. Its options are the base's plus its own; its endpoints, framing and error
 * typing are the base's unless it gives its own.
 */
export function extendProtocol<O, S, E = JsonObject>(
  base: Protocol<O, S>,
  extension: ProtocolExtension<E, S>,
): Protocol<O & E, S> {
  checkShape({ ...extension, endpoints: extension.endpoints ?? {} } as unknown as {
    id: string;
  } & Record<string, unknown>);
  const keys = mergeOptions(base, extension);
  return Object.freeze({
    id: extension.id,
    name: extension.name,
    description: extension.description,
    endpoints: { ...base.endpoints, ...extension.endpoints },
    options: keys.schema,
    ...(base.continuation ? { continuation: base.continuation } : {}),
    ...(extension.reasoning ? { reasoning: extension.reasoning } : {}),
    ...(extension.custom ? { custom: extension.custom } : {}),
    ...either('framing', extension, base),
    ...either('error', extension, base),
    ...either('embeddingLimits', extension, base),
    base: base as Protocol,
    lineage: Object.freeze([extension.id, ...base.lineage]),
    create: (context: ProtocolContext<O & E>) =>
      extendedOperations((request) => extendedCall(base, extension, keys, context, request)),
  }) as Protocol<O & E, S>;
}

/** Whether something `writer` wrote may go back to `target`: the writer is in its lineage. */
export function carriesTo(writer: string, target: Pick<Protocol, 'lineage'>): boolean {
  return target.lineage.includes(writer);
}
