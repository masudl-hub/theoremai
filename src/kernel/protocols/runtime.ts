import { kindOfHttpStatus, TheoremError } from '../../guardrails/error.ts';
import { labelText } from '../../guardrails/labels.ts';
import { retryTransient, type Wait, waitDefault } from '../../providers/shared/retry.ts';
import { readSseChunks } from '../../providers/shared/sse.ts';
import { networkFetch, tapFetch } from '../../providers/shared/upstream-tap.ts';
import { KEY_FALLBACK_ROW } from '../../providers/types.ts';
import { type JsonObject, type JsonValue, jsonValueSchema } from '../json.ts';
import type { KeyVault } from '../registry/vault.ts';
import type { DecisionResult, KeySlot } from '../types.ts';
import { bytesToBase64 } from '../util/base64.ts';
import {
  bindingServe,
  type DecisionModelBinding,
  keySlotsOf,
  type ModelBinding,
} from './binding.ts';
import { type ProviderLimits, resolveProviderLimits } from './limits.ts';
import { costFromPrices } from './prices.ts';
import type {
  DecisionCall,
  EmbeddingCall,
  EmbeddingResult,
  ModelProfileType,
  Protocol,
  ProtocolContext,
  ProtocolEvent,
  ProtocolOperations,
  ProtocolRequest,
  ProtocolSocket,
  SendInit,
} from './protocol.ts';
import type { Outgoing, RegisteredProvider, Serve, Signer } from './provider.ts';

/** Opens a WebSocket with the headers and subprotocols a sign-in put on it. */
export type OpenWebSocket = (
  url: string,
  init: { headers: Headers; protocols: string[] },
) => Promise<WebSocket>;

/**
 * The runtime's own WebSocket. It takes no headers, so a sign-in that needs them is refused; a host
 * that can send them passes `openWebSocket`.
 */
export function plainWebSocket(provider: string): OpenWebSocket {
  return (url, init) => {
    if ([...init.headers.keys()].length)
      throw new TheoremError('unsupported', labelText('protocol.ws_headers', { provider }));
    return Promise.resolve(new WebSocket(url, init.protocols));
  };
}

/** What a host lends every provider call: its keys, its network, its clock and its budgets. */
export interface ProviderHostOptions {
  limits?: Partial<ProviderLimits>;
  vault?: KeyVault;
  fetch?: typeof fetch;
  wait?: Wait;
  openWebSocket?: OpenWebSocket;
}

/** One call's setup: a checked binding on its registered provider, and the host's means. */
export interface CallSetup {
  provider: RegisteredProvider;
  binding: ModelBinding | DecisionModelBinding;
  profileType: ModelProfileType;
  vault?: KeyVault;
  fetch?: typeof fetch;
  wait?: Wait;
  /** Milliseconds the call has left; a retry never waits past it, so the real cause is reported. */
  timeLeft?(): number;
  openWebSocket?: OpenWebSocket;
  limits?: ProviderLimits;
  signal?: AbortSignal;
  tapUpstream?(row: JsonObject): void;
  /** Hands the wire rows to the stream as `raw` events, for looking around. */
  rawRows?: boolean;
  /** Told the slot and key each attempt signs with, so the caller can redact it and key its state. */
  onKey?(slot: KeySlot | undefined, key: unknown): void;
}

const CALL_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A tool-call id Theorem owns: 24 letters and digits, the same for every provider. */
function mintCallId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let id = '';
  for (const byte of bytes) id += CALL_ID_ALPHABET[byte % CALL_ID_ALPHABET.length];
  return id;
}

function serveOf(setup: CallSetup): Serve {
  return bindingServe(setup.provider, setup.binding);
}

const signers = new WeakMap<RegisteredProvider, Map<string, { key: unknown; signer: Signer }>>();

/** A slot's entry, only when the vault holds it itself: an inherited one is never a key. */
function vaultEntry(vault: KeyVault | undefined, slot: string): KeyVault[string] | undefined {
  return vault && Object.hasOwn(vault, slot) ? vault[slot] : undefined;
}

async function signerFor(
  setup: CallSetup,
  serve: Serve,
  slot: KeySlot | undefined,
): Promise<Signer | undefined> {
  const { definition } = setup.provider;
  const authorize = serve.authorize ?? definition.authorize;
  if (!definition.key || !authorize) return undefined;
  const entry = slot ? vaultEntry(setup.vault, slot) : undefined;
  const raw =
    typeof entry === 'function'
      ? await entry({
          providerId: setup.provider.id,
          apiId: setup.binding.apiId,
          keySlot: slot as KeySlot,
          ...(setup.signal ? { signal: setup.signal } : {}),
        })
      : entry;
  const value = typeof raw === 'string' ? raw.trim() || undefined : raw;
  const parsed = definition.key.safeParse(value);
  // invariant: a named slot promises a key, even where the provider's key is optional.
  if (!parsed.success || (slot && value === undefined))
    throw new TheoremError(
      'auth',
      value === undefined
        ? labelText('provider.credential_missing', { slot: slot ?? '' })
        : labelText('protocol.key_invalid', { slot: slot ?? '', provider: setup.provider.id }),
    );
  if (parsed.data === undefined) return undefined;
  setup.onKey?.(slot, parsed.data);
  const cacheKey = `${serve.protocol.id}\u0000${slot ?? ''}`;
  const cache = signers.get(setup.provider) ?? new Map();
  signers.set(setup.provider, cache);
  const held = cache.get(cacheKey);
  if (held && JSON.stringify(held.key) === JSON.stringify(parsed.data)) return held.signer;
  const signer = authorize(parsed.data);
  cache.set(cacheKey, { key: parsed.data, signer });
  return signer;
}

function urlFor(serve: Serve, path: string, apiId: string, stream: boolean): URL {
  if (serve.url) return new URL(serve.url({ path, apiId, stream }));
  return new URL(serve.baseUrl.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`));
}

async function* defaultFraming(response: Response, stream: boolean): AsyncIterable<JsonObject> {
  const type = response.headers.get('content-type') ?? '';
  if (!stream && !/json/i.test(type)) {
    // why: a body that is not JSON (audio, an image) is one row; the tape keeps its hash, not its bytes.
    const bytes = new Uint8Array(await response.arrayBuffer());
    yield { eventType: 'http_body', mime_type: type, data: bytesToBase64(bytes) };
    return;
  }
  if (!stream) {
    yield (await response.json()) as JsonObject;
    return;
  }
  if (!response.body) return;
  for await (const row of readSseChunks(response.body)) {
    if (row.eventType === 'sse_done') return;
    yield row as JsonObject;
  }
}

/**
 * A refused request's body: its JSON, the JSON a streamed refusal carries on its `data:` lines
 * (Google answers `?alt=sse` with `event: error`), or else the text.
 */
function failureBody(text: string): JsonValue {
  const data = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n');
  for (const candidate of data ? [text, data] : [text]) {
    try {
      return JSON.parse(candidate) as JsonValue;
    } catch {
      // why: a body that is not JSON is passed on as text.
    }
  }
  return text;
}

async function failure(
  protocol: Protocol,
  provider: string,
  response: Response,
): Promise<TheoremError> {
  const body = failureBody(await response.text());
  const error =
    protocol.error?.({ status: response.status, body, headers: response.headers }) ??
    new TheoremError(
      kindOfHttpStatus(response.status),
      labelText('protocol.http', { provider, status: response.status }),
    );
  // why: the host reads the upstream status beside the kind, e.g. a decision's 403 is `permission`.
  return Object.assign(error, { status: response.status });
}

/**
 * invariant: the ids this request asks for, not the binding's whole list: a step that answers
 * only, or a turn that toggles a tool off, sends fewer than the binding names.
 */
function builtinIds(request: ProtocolRequest): string[] {
  return request.builtins.map((builtin) => builtin.id);
}

function refuseUnwritten(
  protocol: Protocol,
  asked: readonly string[],
  wrote: readonly string[] = [],
): void {
  const tool = asked.find((id) => !wrote.includes(id));
  if (tool !== undefined)
    throw new TheoremError(
      'unsupported',
      labelText('protocol.builtin_unwritten', { protocol: protocol.id, tool }),
    );
}

async function frameText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return await data.text();
  return String(data);
}

function frameRow(text: string): JsonObject {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject;
  } catch {
    // why: a frame that is not JSON is handed on as text, for the protocol to refuse by name.
  }
  return { eventType: 'ws_unparsed', data: text };
}

/**
 * A WebSocket as JSON frames in and out, in the order they happened. Frames sent before it opens
 * wait for it; frames arriving before anyone reads are kept. A socket error is a
 * `{ eventType: 'ws_error' }` row, and the last row is `{ eventType: 'ws_close', code, reason }`,
 * so the protocol reads what the close means.
 */
function socketFrames(socket: WebSocket, tap: (row: JsonObject) => void): ProtocolSocket {
  const queue: JsonObject[] = [];
  const waiting: string[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let order = Promise.resolve();
  const arrive = (row: JsonObject) => {
    tap(row);
    queue.push(row);
    wake?.();
  };
  const then = (step: () => void | Promise<void>) => {
    order = order.then(step);
  };
  socket.addEventListener('open', () => {
    for (const frame of waiting.splice(0)) socket.send(frame);
  });
  socket.addEventListener('message', (event) =>
    then(async () => {
      const text = await frameText((event as MessageEvent).data);
      if (text.trim()) arrive(frameRow(text));
    }),
  );
  socket.addEventListener('error', () => then(() => arrive({ eventType: 'ws_error' })));
  socket.addEventListener('close', (event) =>
    then(() => {
      const { code, reason } = event as CloseEvent;
      arrive({ eventType: 'ws_close', code, reason });
      closed = true;
    }),
  );
  return {
    send(frame, input) {
      tap({
        eventType: 'ws_send',
        body: frame,
        ...(input?.length ? { input: jsonValueSchema.parse(input) } : {}),
      });
      const text = JSON.stringify(frame);
      if (socket.readyState === WebSocket.CONNECTING) waiting.push(text);
      else socket.send(text);
    },
    async *frames() {
      for (;;) {
        const next = queue.shift();
        if (next) yield next;
        else if (closed) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    },
    close(code, reason) {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
        socket.close(code, reason);
    },
  };
}

/** The context one protocol call gets: `send` and `connect` carry the URL, headers and sign-in. */
function protocolContext(
  setup: CallSetup,
  slot: KeySlot | undefined,
  raw: JsonObject[],
  wire: { sent: boolean } = { sent: false },
  asked: readonly string[] = [],
): ProtocolContext<unknown> {
  const serve = serveOf(setup);
  const { protocol } = serve;
  const { apiId } = setup.binding;
  const builtInTools =
    ('builtInTools' in setup.binding ? setup.binding.builtInTools : undefined) ?? [];
  const tap = (row: JsonObject) => {
    setup.tapUpstream?.(row);
    if (setup.rawRows) raw.push(row);
  };
  const pathFor = (path: string | undefined) => {
    const chosen = path ?? protocol.endpoints[setup.profileType];
    if (chosen === undefined)
      throw new TheoremError(
        'unsupported',
        labelText('protocol.profile_type', {
          protocol: protocol.id,
          profileType: setup.profileType,
        }),
      );
    return chosen;
  };
  return {
    profileType: setup.profileType,
    apiId,
    options: setup.binding.options ?? {},
    builtInTools,
    limits: setup.limits ?? resolveProviderLimits(),
    ...(setup.signal ? { signal: setup.signal } : {}),
    tapUpstream: tap,
    async *send(body, init: SendInit) {
      refuseUnwritten(protocol, asked, init.wroteTools);
      const headers = new Headers({ 'content-type': 'application/json' });
      if (init.stream) headers.set('accept', 'text/event-stream');
      for (const [name, value] of Object.entries(serve.headers ?? {})) headers.set(name, value);
      for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value);
      const outgoing: Outgoing = {
        transport: 'http',
        url: urlFor(serve, pathFor(init.path), apiId, init.stream),
        headers,
        protocols: [],
        body: JSON.stringify(body),
      };
      await (await signerFor(setup, serve, slot))?.sign(outgoing);
      const post = retryTransient(
        tapFetch(
          setup.tapUpstream && ((row) => setup.tapUpstream?.(row as JsonObject)),
          networkFetch(setup.fetch ?? fetch),
          slot,
        ),
        setup.wait ?? waitDefault,
        setup.timeLeft,
      );
      wire.sent = true;
      const response = await post(outgoing.url, {
        method: 'POST',
        headers: outgoing.headers,
        body: outgoing.body ?? null,
        ...(setup.signal ? { signal: setup.signal } : {}),
      });
      if (!response.ok) throw await failure(protocol, setup.provider.id, response);
      for await (const row of (protocol.framing ?? defaultFraming)(response, init.stream)) {
        tap(row);
        yield row;
      }
    },
    async connect(setupFrame, init) {
      refuseUnwritten(protocol, asked, init?.wroteTools);
      const outgoing: Outgoing = {
        transport: 'ws',
        url: urlFor(serve, pathFor(undefined), apiId, true),
        headers: new Headers(serve.headers),
        protocols: [],
      };
      await (await signerFor(setup, serve, slot))?.sign(outgoing);
      const open = setup.openWebSocket ?? plainWebSocket(setup.provider.id);
      wire.sent = true;
      const socket = socketFrames(
        await open(outgoing.url.toString(), {
          headers: outgoing.headers,
          protocols: outgoing.protocols,
        }),
        tap,
      );
      socket.send(setupFrame);
      return socket;
    },
  };
}

function isKind(error: unknown, kind: string): boolean {
  return error instanceof TheoremError && error.kind === kind;
}

/**
 * Runs one call with the kernel's retries, all before the first event: once on the fallback slot
 * when the first key is out of quota, and once after an `auth` refusal with the minted token
 * dropped. A fallback starts clean: it may be another account, so it never sends the first key's
 * state.
 */
async function* withKeys<E>(
  setup: CallSetup,
  run: (slot: KeySlot | undefined, clean: boolean) => AsyncIterable<E>,
): AsyncIterable<E> {
  const { keySlot: primary, fallbackKeySlot: fallback } = keySlotsOf(setup.provider, setup.binding);
  let slot = primary;
  let clean = false;
  let refreshed = false;
  for (;;) {
    let started = false;
    try {
      for await (const event of run(slot, clean)) {
        started = true;
        yield event;
      }
      return;
    } catch (error) {
      if (started) throw error;
      if (
        isKind(error, 'rate_limit') &&
        fallback &&
        slot !== fallback &&
        holdsKey(setup, fallback)
      ) {
        setup.tapUpstream?.({
          eventType: KEY_FALLBACK_ROW,
          from: slot ?? null,
          keySlot: fallback,
          errorKind: (error as TheoremError).kind,
          error: (error as TheoremError).message,
        });
        slot = fallback;
        clean = true;
      } else if (isKind(error, 'auth') && !refreshed) {
        refreshed = true;
        const serve = serveOf(setup);
        signers
          .get(setup.provider)
          ?.get(`${serve.protocol.id}\u0000${slot ?? ''}`)
          ?.signer.invalidate?.();
      } else throw error;
    }
  }
}

/** Whether the vault has something under the slot; an empty slot is never tried. */
function holdsKey(setup: CallSetup, slot: KeySlot): boolean {
  const entry = vaultEntry(setup.vault, slot);
  if (typeof entry === 'string') return entry.trim() !== '';
  return typeof entry === 'function' || (typeof entry === 'object' && entry !== null);
}

/**
 * A failure once the call is sent ends it as an `error` event, so the turn keeps what it showed
 * and may resume. A cancel, a config mistake, or anything refused before sending still throws.
 */
function failureEvent(error: unknown): ProtocolEvent {
  if (!(error instanceof TheoremError) || error.kind === 'cancelled' || error.kind === 'config')
    throw error;
  return {
    type: 'error',
    errorKind: error.kind,
    // invariant: `error` is the person's wording, added from the profile's labels; the upstream text is internal.
    errorInternal: error.message,
    ...(error.copy ? { errorCopy: error.copy } : {}),
  } as ProtocolEvent;
}

function cleanRequest<S>(request: ProtocolRequest<S>): ProtocolRequest<S> {
  if (request.state === undefined) return request;
  if (!request.history?.length)
    throw new TheoremError('request', labelText('protocol.history_needed'));
  const { state: _state, stateHistoryLength: _length, ...rest } = request;
  return rest as ProtocolRequest<S>;
}

/** Theorem's id on each call, the wire's kept beside it; origin and estimated cost filled in. */
function finishEvents(setup: CallSetup) {
  const ids = new Map<string, string>();
  const idFor = (wire: string) => {
    const held = ids.get(wire);
    if (held) return held;
    const minted = mintCallId();
    ids.set(wire, minted);
    return minted;
  };
  const prices = setup.provider.definition.prices;
  const wireOf = (id: string) => {
    for (const [wire, minted] of ids) if (minted === id) return wire;
    return id;
  };
  const finish = (event: ProtocolEvent): ProtocolEvent => {
    switch (event.type) {
      case 'tool_call':
        return {
          ...event,
          call: { ...event.call, callId: idFor(event.call.callId), wireCallId: event.call.callId },
        };
      case 'tool_cancel':
      case 'tool_draft':
        return { ...event, callId: idFor(event.callId) };
      case 'reasoning':
        return {
          ...event,
          origin: {
            protocol: event.origin?.protocol ?? setup.binding.protocol,
            provider: setup.provider.id,
            apiId: setup.binding.apiId,
          },
        };
      case 'tokens': {
        if (event.tokens.cost || !prices) return event;
        const cost = costFromPrices(prices, setup.binding.apiId, event.tokens);
        return cost ? { ...event, tokens: { ...event.tokens, cost } } : event;
      }
      default:
        return event;
    }
  };
  return { finish, wireOf };
}

/**
 * A decision whose reply has no cost gets one from the provider's prices for the model the reply
 * names, marked estimated; a model the prices don't cover stays unpriced.
 */
function pricedDecision(setup: CallSetup, result: DecisionResult): DecisionResult {
  const prices = setup.provider.definition.prices;
  if (!result.usage || result.usage.costUsd !== undefined || !prices) return result;
  const { inputTokens: input, outputTokens: output } = result.usage;
  const cost = costFromPrices(prices, result.model, {
    input,
    output,
    total: input + output,
  });
  return cost
    ? { ...result, usage: { ...result.usage, costUsd: cost.usd, estimated: true } }
    : result;
}

function protocolFor(setup: CallSetup): Protocol {
  return serveOf(setup).protocol;
}

function operation<K extends keyof ProtocolOperations>(
  protocol: Protocol,
  operations: ProtocolOperations,
  name: K,
): NonNullable<ProtocolOperations[K]> {
  const found = operations[name];
  if (!found)
    throw new TheoremError(
      'unsupported',
      labelText('protocol.no_operation', { protocol: protocol.id, operation: name }),
    );
  const method = found as (...args: unknown[]) => unknown;
  return ((...args: unknown[]) => method.apply(operations, args)) as NonNullable<
    ProtocolOperations[K]
  >;
}

/** The operations that answer once, with what each takes and returns. */
interface OneAnswer {
  decide: [DecisionCall, DecisionResult];
  embed: [EmbeddingCall, EmbeddingResult];
}

/** One request with one answer, tried across the binding's key slots. */
async function answerOnce<K extends keyof OneAnswer>(
  setup: CallSetup,
  name: K,
  request: OneAnswer[K][0],
): Promise<OneAnswer[K][1]> {
  const protocol = protocolFor(setup);
  for await (const result of withKeys(setup, (slot) =>
    (async function* () {
      const operations = protocol.create(protocolContext(setup, slot, []));
      const run = operation(protocol, operations, name) as (
        request: OneAnswer[K][0],
      ) => Promise<OneAnswer[K][1]>;
      yield await run(request);
    })(),
  ))
    return result;
  throw new TheoremError('internal', labelText('provider.decision_failed'));
}

/**
 * One binding's call, as the kernel runs it: the protocol's operations with the kernel's retries,
 * ids, origins and prices around them.
 */
/** What the kernel runs for one binding. */
export type ProtocolCall = Required<Omit<ProtocolOperations, 'decide'>> & {
  decide(request: DecisionCall): Promise<DecisionResult>;
  embed(request: EmbeddingCall): Promise<EmbeddingResult>;
};

export function callProtocol(setup: CallSetup): ProtocolCall {
  const protocol = protocolFor(setup);
  return {
    async *complete(request) {
      const { finish } = finishEvents(setup);
      const raw: JsonObject[] = [];
      const wire = { sent: false };
      const events = withKeys(setup, (slot, clean) => {
        wire.sent = false;
        const operations = protocol.create(
          protocolContext(setup, slot, raw, wire, builtinIds(request)),
        ) as ProtocolOperations;
        return operation(protocol, operations, 'complete')(clean ? cleanRequest(request) : request);
      });
      try {
        for await (const event of events) {
          for (const row of raw.splice(0)) yield { type: 'raw', row };
          yield finish(event);
        }
      } catch (error) {
        for (const row of raw.splice(0)) yield { type: 'raw', row };
        if (!wire.sent) throw error;
        yield failureEvent(error);
        return;
      }
      for (const row of raw.splice(0)) yield { type: 'raw', row };
    },
    async openSession(request) {
      const { finish, wireOf } = finishEvents(setup);
      const raw: JsonObject[] = [];
      let opened: Awaited<ReturnType<NonNullable<ProtocolOperations['openSession']>>> | undefined;
      for await (const session of withKeys(setup, (slot, clean) =>
        (async function* () {
          const operations = protocol.create(
            protocolContext(setup, slot, raw, undefined, builtinIds(request)),
          ) as ProtocolOperations;
          yield await operation(
            protocol,
            operations,
            'openSession',
          )(clean ? cleanRequest(request) : request);
        })(),
      ))
        opened = session;
      const session = opened as NonNullable<typeof opened>;
      return {
        ...session,
        // why: the wire matches a result to the id it issued, never Theorem's.
        sendToolResult: (result) =>
          session.sendToolResult({ ...result, callId: wireOf(result.callId) }),
        async *events() {
          for await (const event of session.events()) {
            for (const row of raw.splice(0)) yield { type: 'raw', row };
            yield finish(event);
          }
        },
      };
    },
    decide: async (request) => pricedDecision(setup, await answerOnce(setup, 'decide', request)),
    embed: (request) => answerOnce(setup, 'embed', request),
  };
}
