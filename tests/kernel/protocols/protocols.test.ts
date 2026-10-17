import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { z } from 'zod';
import { TheoremError } from '../../../src/guardrails/error.ts';
import type { JsonObject } from '../../../src/kernel/json.ts';
import {
  bearer,
  type CallSetup,
  callProtocol,
  carriesTo,
  checkBinding,
  costFromPrices,
  createProviderRegistry,
  defineProtocol,
  defineProvider,
  extendProtocol,
  header,
  type ProtocolEvent,
  type ProtocolRequest,
  query,
} from '../../../src/kernel/protocols/mod.ts';
import { failureOf } from '../../fixtures/failure.ts';

/** A protocol that posts the request's text and streams back what each row says. */
const echo = defineProtocol({
  id: 'echo',
  name: 'Echo',
  description: 'Streams back what it is sent.',
  endpoints: { text: '/echo', live: '/live' },
  options: z.strictObject({ loud: z.boolean().optional().describe('Shout.') }),
  reasoning: z.strictObject({ signature: z.string() }),
  custom: { note: z.strictObject({ said: z.string() }) },
  create: (context) => ({
    async *complete() {
      const wrote = context.builtInTools.filter((id) => id === 'search');
      for await (const row of context.send(
        { loud: context.options.loud ?? false },
        { stream: true, wroteTools: wrote },
      )) {
        if (typeof row.text === 'string') yield { type: 'text', text: row.text } as ProtocolEvent;
        if (typeof row.signature === 'string')
          yield { type: 'reasoning', data: { signature: row.signature } };
        if (typeof row.call === 'string')
          yield { type: 'tool_call', call: { callId: row.call, name: 'look', arguments: {} } };
        if (typeof row.input === 'number')
          yield {
            type: 'tokens',
            tokens: {
              input: row.input,
              output: Number(row.output ?? 0),
              total: row.input + Number(row.output ?? 0),
            },
          };
      }
      yield { type: 'done', stop: { kind: 'completed' } } as ProtocolEvent;
    },
  }),
});

const routed = extendProtocol(echo, {
  id: 'routedEcho',
  name: 'Routed echo',
  description: 'Echo with a route and citations.',
  options: z.strictObject({ route: z.string().optional().describe('Where to route.') }),
  custom: { citation: z.strictObject({ url: z.string() }) },
  reasoning: z.strictObject({ details: z.string() }),
  body: (body, at) => ({
    body: { ...body, route: at.options.route ?? 'any' },
    wroteTools: at.builtInTools.filter((id) => id === 'web'),
  }),
  read: () => {
    let seen = 0;
    return {
      row(row: JsonObject) {
        seen += 1;
        if (typeof row.cite === 'string')
          return {
            events: [{ type: 'custom', kind: 'citation', data: { url: row.cite } }],
            consumed: true,
          };
        return {};
      },
      finish: () => ({ events: [{ type: 'reasoning', data: { details: `rows:${seen}` } }] }),
    };
  },
});

function sse(rows: JsonObject[]): Response {
  const text = `${rows.map((row) => `data: ${JSON.stringify(row)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

interface Sent {
  url: string;
  headers: Headers;
  body: JsonObject;
}

function fakeFetch(answer: (sent: Sent, count: number) => Response) {
  const sent: Sent[] = [];
  const send: typeof fetch = (input, init) => {
    const entry = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as JsonObject,
    };
    sent.push(entry);
    return Promise.resolve(answer(entry, sent.length));
  };
  return { sent, send };
}

const host = defineProvider({
  id: 'host',
  name: 'Host',
  description: 'A test host.',
  key: z.string(),
  authorize: bearer(),
  prices: { checked: '2026-10-16', models: { 'm-*': { input: 1, output: 2 } } },
  serves: () => [
    { protocol: echo, baseUrl: 'https://host.test/v1/' },
    { protocol: routed, baseUrl: 'https://host.test/v1', headers: { 'x-title': 'Theorem' } },
  ],
});

function setupFor(
  registry: ReturnType<typeof createProviderRegistry>,
  binding: Parameters<typeof checkBinding>[1],
  send: typeof fetch,
  extra: Partial<CallSetup> = {},
): CallSetup {
  const provider = registry.require(binding.provider, binding.apiId);
  return {
    provider,
    binding: checkBinding(provider, binding, 'text'),
    profileType: 'text',
    vault: { main: 'k-main', spare: 'k-spare' },
    fetch: send,
    wait: async () => {},
    ...extra,
  };
}

const request = {
  system: '',
  input: [],
  builtins: [],
  structured: null,
  image: null,
} as unknown as ProtocolRequest;

async function collect(events: AsyncIterable<ProtocolEvent>): Promise<ProtocolEvent[]> {
  const out: ProtocolEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

Deno.test('an extension adds options, refuses one its base has, and carries its own lineage', () => {
  assertEquals(routed.lineage, ['routedEcho', 'echo']);
  assertEquals(routed.endpoints.text, '/echo');
  assertEquals(routed.options.safeParse({ loud: true, route: 'a' }).success, true);
  assertEquals(routed.options.safeParse({ other: 1 }).success, false);
  assertThrows(
    () =>
      extendProtocol(echo, {
        id: 'clash',
        name: 'Clash',
        description: 'Redefines loud.',
        options: z.strictObject({ loud: z.string() }),
      }),
    TheoremError,
    "adds option 'loud'",
  );
  assertEquals(carriesTo('echo', routed), true);
  assertEquals(carriesTo('routedEcho', echo), false);
});

Deno.test('a registered provider checks its protocols, ids and connection', () => {
  const registry = createProviderRegistry();
  registry.register(host, { keySlot: 'main' });
  assertThrows(
    () => registry.register(host),
    TheoremError,
    "Provider id 'host' is already registered",
  );
  const impostor = defineProtocol({ ...echo, id: 'echo', create: echo.create });
  const other = defineProvider({
    id: 'other',
    name: 'Other',
    description: 'Brings another echo.',
    serves: () => [{ protocol: impostor, baseUrl: 'https://other.test' }],
  });
  assertThrows(
    () => registry.register(other),
    TheoremError,
    "Protocol id 'echo' is already registered",
  );
  const local = defineProvider({
    id: 'local',
    name: 'Local',
    description: 'A local server.',
    connection: z.strictObject({ baseUrl: z.url().describe('Where the server listens.') }),
    serves: (connection) => [{ protocol: echo, baseUrl: connection.baseUrl }],
  });
  assertThrows(
    () => registry.register(local),
    TheoremError,
    "Provider 'local' has an invalid connection",
  );
  registry.register(local, { id: 'ollama', connection: { baseUrl: 'http://localhost:11434/v1' } });
  assertEquals(
    registry
      .protocols()
      .map((protocol) => protocol.id)
      .sort(),
    ['echo', 'routedEcho'],
  );
  const binding = registry
    .require('host', 'm-1')
    .model(routed, 'm-1', { options: { route: 'r', loud: true } });
  assertEquals(binding, {
    protocol: 'routedEcho',
    provider: 'host',
    apiId: 'm-1',
    options: { route: 'r', loud: true },
  });
  assertThrows(
    () => registry.require('host', 'm-1').model('echo', 'm-1', { options: { route: 'r' } }),
    TheoremError,
  );
});

Deno.test('a binding is checked for fit only, and comes back parsed', () => {
  const registry = createProviderRegistry();
  const provider = registry.register(host, { keySlot: 'main' });
  const base = { protocol: 'echo', provider: 'host', apiId: 'anything' };
  assertEquals(checkBinding(provider, base, 'text') as unknown, { ...base, options: {} });
  assertThrows(
    () => checkBinding(provider, { ...base, protocol: 'nope' }, 'text'),
    TheoremError,
    'does not serve',
  );
  assertThrows(
    () => checkBinding(provider, base, 'image'),
    TheoremError,
    "no endpoint for 'image'",
  );
  assertThrows(
    () => checkBinding(provider, { ...base, options: { loud: 'yes' } }, 'text'),
    TheoremError,
    'do not fit',
  );
  assertThrows(
    () => checkBinding(provider, { ...base, fallbackKeySlot: 'main' }, 'text'),
    TheoremError,
  );
  const live = defineProvider({
    ...host,
    id: 'live-host',
    serves: () => [{ protocol: echo, baseUrl: 'wss://h.test' }],
  });
  const liveProvider = createProviderRegistry().register(live);
  assertThrows(
    () =>
      checkBinding(liveProvider, { ...base, provider: 'live-host' }, 'live', {
        webSocketHeaders: false,
      }),
    TheoremError,
    'cannot send on a WebSocket',
  );
  const keyed = defineProvider({ ...live, id: 'keyed', authorize: query('key') });
  const headed = defineProvider({ ...host, id: 'headed', authorize: header('x-api-key') });
  assertEquals(createProviderRegistry().register(headed).id, 'headed');
  checkBinding(createProviderRegistry().register(keyed), { ...base, provider: 'keyed' }, 'live', {
    webSocketHeaders: false,
  });
});

Deno.test('a call is sent where the provider says, signed, with the extension body and reader', async () => {
  const registry = createProviderRegistry();
  registry.register(host, { keySlot: 'main' });
  const { sent, send } = fakeFetch(() =>
    sse([
      { text: 'hi' },
      { cite: 'https://a.test' },
      { signature: 's1' },
      { call: 'wire-1' },
      { input: 1000, output: 500 },
    ]),
  );
  const setup = setupFor(
    registry,
    { protocol: 'routedEcho', provider: 'host', apiId: 'm-2', options: { route: 'r' } },
    send,
  );
  const events = await collect(callProtocol(setup).complete(request));
  assertEquals(sent[0]?.url, 'https://host.test/v1/echo');
  assertEquals(sent[0]?.headers.get('authorization'), 'Bearer k-main');
  assertEquals(sent[0]?.headers.get('x-title'), 'Theorem');
  assertEquals(sent[0]?.body, { loud: false, route: 'r' });
  const kinds = events.map((event) => event.type);
  assertEquals(kinds, ['text', 'custom', 'reasoning', 'tool_call', 'tokens', 'reasoning', 'done']);
  assertEquals(events[1], {
    type: 'custom',
    kind: 'routedEcho.citation',
    data: { url: 'https://a.test' },
  });
  assertEquals(events[2], {
    type: 'reasoning',
    data: { signature: 's1' },
    origin: { protocol: 'echo', provider: 'host', apiId: 'm-2' },
  });
  assertEquals(events[5], {
    type: 'reasoning',
    data: { details: 'rows:5' },
    origin: { protocol: 'routedEcho', provider: 'host', apiId: 'm-2' },
  });
  const call = events[3] as Extract<ProtocolEvent, { type: 'tool_call' }>;
  assertEquals(call.call.wireCallId, 'wire-1');
  assertEquals(/^[A-Za-z0-9]{24}$/.test(call.call.callId), true);
  const tokens = events[4] as Extract<ProtocolEvent, { type: 'tokens' }>;
  assertEquals(tokens.tokens.cost, { usd: 0.002, estimated: true } as never);
});

Deno.test('a built-in tool the turn asked for and no protocol wrote is refused by name before the call', async () => {
  const asking = { ...request, builtins: [{ id: 'web' }] } as ProtocolRequest;
  const registry = createProviderRegistry();
  registry.register(host, { keySlot: 'main' });
  const { sent, send } = fakeFetch(() => sse([]));
  const wrote = setupFor(
    registry,
    { protocol: 'routedEcho', provider: 'host', apiId: 'm', builtInTools: ['search', 'web'] },
    send,
  );
  await collect(callProtocol(wrote).complete(asking));
  const missing = setupFor(
    registry,
    { protocol: 'echo', provider: 'host', apiId: 'm', builtInTools: ['web'] },
    send,
  );
  await assertRejects(
    () => collect(callProtocol(missing).complete(asking)),
    TheoremError,
    "does not write the built-in tool 'web'",
  );
  assertEquals(sent.length, 1);
});

Deno.test('out of quota before the first event, a call retries once on the fallback key, clean', async () => {
  const registry = createProviderRegistry();
  registry.register(host, { keySlot: 'main', fallbackKeySlot: 'spare' });
  const { sent, send } = fakeFetch((entry) =>
    entry.headers.get('authorization') === 'Bearer k-main'
      ? new Response('{}', { status: 429 })
      : sse([{ text: 'ok' }]),
  );
  const setup = setupFor(registry, { protocol: 'echo', provider: 'host', apiId: 'm' }, send);
  const events = await collect(
    callProtocol(setup).complete({
      ...request,
      history: [{ role: 'user', content: 'hi' }],
      state: { id: 1 },
    } as ProtocolRequest),
  );
  assertEquals(
    events.map((event) => event.type),
    ['text', 'done'],
  );
  assertEquals(sent.at(-1)?.headers.get('authorization'), 'Bearer k-spare');
  await assertRejects(
    () =>
      collect(callProtocol(setup).complete({ ...request, state: { id: 1 } } as ProtocolRequest)),
    TheoremError,
    'needs the conversation',
  );
});

Deno.test('a fallback key kept as an object is tried like a string one', async () => {
  const fielded = defineProvider({
    id: 'fielded',
    name: 'Fielded',
    description: 'Signs in with a key of several fields.',
    key: z.object({ token: z.string() }),
    authorize: ({ token }) => ({
      sign: (outgoing: { headers: Headers }) => outgoing.headers.set('authorization', token),
    }),
    serves: () => [{ protocol: echo, baseUrl: 'https://f.test' }],
  });
  const registry = createProviderRegistry();
  registry.register(fielded, { keySlot: 'main', fallbackKeySlot: 'spare' });
  const { sent, send } = fakeFetch((entry) =>
    entry.headers.get('authorization') === 'f-main'
      ? new Response('{}', { status: 429 })
      : sse([{ text: 'ok' }]),
  );
  const setup = setupFor(registry, { protocol: 'echo', provider: 'fielded', apiId: 'm' }, send, {
    vault: { main: { token: 'f-main' }, spare: { token: 'f-spare' } },
  });
  const events = await collect(callProtocol(setup).complete(request));
  assertEquals(
    events.map((event) => event.type),
    ['text', 'done'],
  );
  assertEquals(sent.at(-1)?.headers.get('authorization'), 'f-spare');
});

Deno.test('an auth refusal drops the minted token and retries once', async () => {
  let minted = 0;
  let dropped = 0;
  const minting = defineProvider({
    id: 'minting',
    name: 'Minting',
    description: 'Mints a token per key.',
    key: z.string(),
    authorize: Object.assign(
      () => {
        minted += 1;
        const token = `t${minted}`;
        return {
          sign: (outgoing: { headers: Headers }) => outgoing.headers.set('authorization', token),
          invalidate: () => {
            dropped += 1;
          },
        };
      },
      { webSocketHeaders: true },
    ),
    serves: () => [{ protocol: echo, baseUrl: 'https://m.test' }],
  });
  const registry = createProviderRegistry();
  registry.register(minting, { keySlot: 'main' });
  const { send } = fakeFetch((_entry, count) =>
    count === 1 ? new Response('{}', { status: 401 }) : sse([{ text: 'ok' }]),
  );
  const setup = setupFor(registry, { protocol: 'echo', provider: 'minting', apiId: 'm' }, send);
  const events = await collect(callProtocol(setup).complete(request));
  assertEquals(
    events.map((event) => event.type),
    ['text', 'done'],
  );
  assertEquals(dropped, 1);
});

Deno.test('a failed answer is typed by its status, and raw rows come only when asked', async () => {
  const registry = createProviderRegistry();
  registry.register(host, { keySlot: 'main' });
  const { send } = fakeFetch(() => new Response('{"error":"bad"}', { status: 400 }));
  const setup = setupFor(registry, { protocol: 'echo', provider: 'host', apiId: 'm' }, send);
  assertEquals(failureOf(await collect(callProtocol(setup).complete(request))).kind, 'unsupported');
  const { send: ok } = fakeFetch(() => sse([{ text: 'a' }]));
  const raw = await collect(
    callProtocol(setupFor(registry, setup.binding, ok, { rawRows: true })).complete(request),
  );
  assertEquals(
    raw.map((event) => event.type),
    ['raw', 'text', 'done'],
  );
});

Deno.test('prices: a prefix covers its ids, long prompts take the higher rate, cached input its own', () => {
  const table = {
    checked: '2026-10-16',
    models: {
      'g-*': {
        input: 1,
        output: 4,
        cachedInput: 0.25,
        longContext: { above: 1000, input: 2, output: 8 },
      },
      'g-pro': { input: 3, output: 6 },
    },
  };
  assertEquals(costFromPrices(table, 'g-pro', { input: 1_000_000, output: 0, total: 0 })?.usd, 3);
  assertEquals(
    costFromPrices(table, 'g-flash', { input: 1000, output: 1000, cached: 400, total: 0 })?.usd,
    (600 + 100 + 4000) / 1e6,
  );
  assertEquals(
    costFromPrices(table, 'g-flash', { input: 2000, output: 0, total: 0 })?.usd,
    4000 / 1e6,
  );
  assertEquals(costFromPrices(table, 'other', { input: 1, output: 1, total: 2 }), undefined);
});

Deno.test('prices: a modality with its own rate bills its share, the rest of the side the plain rate', () => {
  const table = {
    checked: '2026-10-16',
    models: {
      live: {
        input: 1,
        output: 4,
        byModality: { input: { audio: 3 }, output: { audio: 12, image: 30 } },
      },
    },
  };
  const tokens = {
    input: 1000,
    output: 1000,
    total: 2000,
    byModality: { input: { audio: 600, text: 400 }, output: { audio: 500, text: 300 } },
  };
  assertEquals(
    costFromPrices(table, 'live', tokens)?.usd,
    (600 * 3 + 400 * 1 + 500 * 12 + 500 * 4) / 1e6,
  );
  assertEquals(
    costFromPrices(table, 'live', {
      input: 10,
      output: 10,
      total: 20,
      byModality: { output: { image: 50 } },
    })?.usd,
    (10 * 1 + 10 * 30) / 1e6,
  );
});
