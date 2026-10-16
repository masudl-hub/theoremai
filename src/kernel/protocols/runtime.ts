import { kindOfHttpStatus, TheoremError } from '../../guardrails/error.ts';
import { labelText } from '../../guardrails/labels.ts';
import { retryTransient, type Wait, waitDefault } from '../../providers/shared/retry.ts';
import { readSseChunks } from '../../providers/shared/sse.ts';
import { networkFetch, tapFetch } from '../../providers/shared/upstream-tap.ts';
import {
  type JsonObject,
  type JsonValue,
  type ProviderLimits,
  type ProviderVault,
  resolveProviderLimits,
} from '../provider-contract.ts';
import type { DecisionResult, KeySlot } from '../types.ts';
import type { DecisionModelBinding, ModelBinding } from './binding.ts';
import { costFromPrices } from './prices.ts';
import type {
  DecisionCall,
  PricedDecision,
  ProfileType,
  Protocol,
  ProtocolContext,
  ProtocolEvent,
  ProtocolOperations,
  ProtocolSocket,
  SendInit,
  TurnRequest,
} from './protocol.ts';
import type { Outgoing, RegisteredProvider, Serve, Signer } from './provider.ts';

/** Opens a WebSocket with the headers and subprotocols a sign-in put on it. */
export type OpenWebSocket = (
  url: string,
  init: { headers: Headers; protocols: string[] },
) => Promise<WebSocket>;

/** One call's setup: a checked binding on its registered provider, and the host's means. */
export interface CallSetup {
  provider: RegisteredProvider;
  binding: ModelBinding | DecisionModelBinding;
  profileType: ProfileType;
  vault?: ProviderVault;
  fetch?: typeof fetch;
  wait?: Wait;
  openWebSocket?: OpenWebSocket;
  limits?: ProviderLimits;
  signal?: AbortSignal;
  tapUpstream?(row: JsonObject): void;
  /** Hands the wire rows to the stream as `raw` events, for looking around. */
  rawRows?: boolean;
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
  const serve = setup.provider.serves.find((entry) => entry.protocol.id === setup.binding.protocol);
  if (!serve)
    throw new TheoremError(
      'config',
      labelText('protocol.not_served', {
        provider: setup.provider.id,
        protocol: setup.binding.protocol,
      }),
    );
  return serve;
}

const signers = new WeakMap<RegisteredProvider, Map<string, { key: unknown; signer: Signer }>>();

async function signerFor(
  setup: CallSetup,
  serve: Serve,
  slot: KeySlot | undefined,
): Promise<Signer | undefined> {
  const { definition } = setup.provider;
  const authorize = serve.authorize ?? definition.authorize;
  if (!definition.key || !authorize) return undefined;
  const entry = slot ? setup.vault?.[slot] : undefined;
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
  if (!parsed.success)
    throw new TheoremError(
      'auth',
      value === undefined
        ? labelText('provider.credential_missing', { slot: slot ?? '' })
        : labelText('protocol.key_invalid', { slot: slot ?? '', provider: setup.provider.id }),
    );
  if (parsed.data === undefined) return undefined;
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

async function failure(
  protocol: Protocol,
  provider: string,
  response: Response,
): Promise<TheoremError> {
  const text = await response.text();
  let body: JsonValue = text;
  try {
    body = JSON.parse(text) as JsonValue;
  } catch {
    // why: a body that is not JSON is passed on as text.
  }
  return (
    protocol.error?.({ status: response.status, body, headers: response.headers }) ??
    new TheoremError(
      kindOfHttpStatus(response.status),
      labelText('protocol.http', { provider, status: response.status }),
    )
  );
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

/** A WebSocket as JSON frames in and out. Frames arriving before anyone reads are kept. */
function socketFrames(socket: WebSocket): ProtocolSocket {
  const queue: JsonObject[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  socket.addEventListener('message', (event) => {
    try {
      queue.push(JSON.parse(String((event as MessageEvent).data)) as JsonObject);
    } catch {
      queue.push({ eventType: 'ws_unparsed', data: String((event as MessageEvent).data) });
    }
    wake?.();
  });
  socket.addEventListener('close', () => {
    closed = true;
    wake?.();
  });
  return {
    send: (frame) => socket.send(JSON.stringify(frame)),
    async *frames() {
      for (;;) {
        const next = queue.shift();
        if (next) yield next;
        else if (closed) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    },
    close: (code, reason) => socket.close(code, reason),
  };
}

/** The context one protocol call gets: `send` and `connect` carry the URL, headers and sign-in. */
function protocolContext(
  setup: CallSetup,
  slot: KeySlot | undefined,
  raw: JsonObject[],
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
      refuseUnwritten(protocol, builtInTools, init.wroteTools);
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
      );
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
      refuseUnwritten(protocol, builtInTools, init?.wroteTools);
      const outgoing: Outgoing = {
        transport: 'ws',
        url: urlFor(serve, pathFor(undefined), apiId, true),
        headers: new Headers(serve.headers),
        protocols: [],
      };
      await (await signerFor(setup, serve, slot))?.sign(outgoing);
      if (!setup.openWebSocket)
        throw new TheoremError(
          'unsupported',
          labelText('protocol.ws_headers', { provider: setup.provider.id }),
        );
      const socket = socketFrames(
        await setup.openWebSocket(outgoing.url.toString(), {
          headers: outgoing.headers,
          protocols: outgoing.protocols,
        }),
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
  const primary = setup.binding.keySlot ?? setup.provider.keySlot;
  const fallback = setup.binding.fallbackKeySlot ?? setup.provider.fallbackKeySlot;
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
      if (isKind(error, 'rate_limit') && fallback && slot !== fallback) {
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

function cleanRequest<S>(request: TurnRequest<S>): TurnRequest<S> {
  if (request.state === undefined) return request;
  if (!request.history?.length)
    throw new TheoremError('request', labelText('protocol.history_needed'));
  const { state: _state, stateHistoryLength: _length, ...rest } = request;
  return rest as TurnRequest<S>;
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
  return (event: ProtocolEvent): ProtocolEvent => {
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
}

/** A decision whose reply has no cost gets one from the provider's prices, marked estimated. */
function pricedDecision(setup: CallSetup, result: DecisionResult): PricedDecision {
  const prices = setup.provider.definition.prices;
  if (!result.usage || result.usage.costUsd !== undefined || !prices) return result;
  const { inputTokens: input, outputTokens: output } = result.usage;
  const cost = costFromPrices(prices, setup.binding.apiId, {
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

/**
 * One binding's call, as the kernel runs it: the protocol's operations with the kernel's retries,
 * ids, origins and prices around them.
 */
/** What the kernel runs for one binding. */
export type ProtocolCall = Required<Omit<ProtocolOperations, 'decide'>> & {
  decide(request: DecisionCall): Promise<PricedDecision>;
};

export function callProtocol(setup: CallSetup): ProtocolCall {
  const protocol = protocolFor(setup);
  return {
    async *complete(request) {
      const finish = finishEvents(setup);
      const raw: JsonObject[] = [];
      const events = withKeys(setup, (slot, clean) => {
        const operations = protocol.create(protocolContext(setup, slot, raw)) as ProtocolOperations;
        return operation(protocol, operations, 'complete')(clean ? cleanRequest(request) : request);
      });
      for await (const event of events) {
        for (const row of raw.splice(0)) yield { type: 'raw', row };
        yield finish(event);
      }
      for (const row of raw.splice(0)) yield { type: 'raw', row };
    },
    async openSession(request) {
      const finish = finishEvents(setup);
      const raw: JsonObject[] = [];
      let opened: Awaited<ReturnType<NonNullable<ProtocolOperations['openSession']>>> | undefined;
      for await (const session of withKeys(setup, (slot, clean) =>
        (async function* () {
          const operations = protocol.create(
            protocolContext(setup, slot, raw),
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
        async *events() {
          for await (const event of session.events()) {
            for (const row of raw.splice(0)) yield { type: 'raw', row };
            yield finish(event);
          }
        },
      };
    },
    async decide(request) {
      for await (const result of withKeys(setup, (slot) =>
        (async function* () {
          const operations = protocol.create(protocolContext(setup, slot, []));
          yield await operation(protocol, operations, 'decide')(request);
        })(),
      ))
        return pricedDecision(setup, result);
      throw new TheoremError('internal', labelText('provider.decision_failed'));
    },
  };
}
