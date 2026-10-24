import { assertEquals } from '@std/assert';
import { z } from 'zod';
import type { JsonObject } from '../../../src/kernel/json.ts';
import {
  bearer,
  type CallSetup,
  callProtocol,
  carriesTo,
  checkBinding,
  createProviderRegistry,
  defineProvider,
  type ProtocolEvent,
  type ProtocolRequest,
} from '../../../src/kernel/protocols/mod.ts';
import { openAi } from '../../../src/providers/open-ai/protocol.ts';
import { openRouterOpenAi } from '../../../src/providers/openrouter/protocol.ts';

const router = defineProvider({
  id: 'router',
  name: 'Router',
  description: 'A gateway that speaks OpenRouter Chat Completions.',
  key: z.string(),
  authorize: bearer(),
  serves: () => [{ protocol: openRouterOpenAi, baseUrl: 'https://router.test/api/v1' }],
});

function sse(rows: JsonObject[]): Response {
  const text = `${rows.map((row) => `data: ${JSON.stringify(row)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

function setup(rows: JsonObject[], options: JsonObject = {}) {
  const sent: JsonObject[] = [];
  const send: typeof fetch = (_input, init) => {
    sent.push(JSON.parse(String(init?.body)) as JsonObject);
    return Promise.resolve(sse(rows));
  };
  const registry = createProviderRegistry();
  registry.register(router, { keySlot: 'main' });
  const provider = registry.require('router', 'm-1');
  const call: CallSetup = {
    provider,
    binding: checkBinding(
      provider,
      {
        protocol: 'openRouterOpenAi',
        provider: 'router',
        apiId: 'm-1',
        builtInTools: ['webSearch'],
        options,
      },
      'text',
    ),
    profileType: 'text',
    vault: { main: 'k-main' },
    fetch: send,
    wait: async () => {},
  };
  return { sent, call };
}

const signed = { details: [{ type: 'reasoning.encrypted', data: 'opaque' }], content: 'Plan.' };

const request = {
  system: 'Be brief.',
  input: [{ type: 'text', text: 'And tomorrow?' }],
  builtins: [],
  structured: null,
  image: null,
  thinking: 'high',
  sessionId: 's-1',
  history: [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
      reasoning: [{ data: signed, origin: { protocol: 'openRouterOpenAi' } }],
    },
    { role: 'tool', tool_call_id: 'c1', name: 'weather', content: 'Sunny.' },
  ],
} as unknown as ProtocolRequest;

async function collect(events: AsyncIterable<ProtocolEvent>): Promise<ProtocolEvent[]> {
  const out: ProtocolEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

Deno.test('openRouterOpenAi extends openAi and only it takes OpenRouter reasoning back', () => {
  assertEquals(openRouterOpenAi.lineage, ['openRouterOpenAi', 'openAi']);
  assertEquals(openRouterOpenAi.endpoints.text, '/chat/completions');
  assertEquals(carriesTo('openRouterOpenAi', openAi), false);
});

Deno.test('openRouterOpenAi writes its body: effort, routing, cache, session, web search, reasoning', async () => {
  const { sent, call } = setup(
    [{ choices: [{ delta: { content: 'Rain.' }, finish_reason: 'stop' }] }],
    { cache: { mode: 'system', ttl: '1h' } },
  );
  await collect(callProtocol(call).complete(request));
  const body = sent[0] ?? {};
  assertEquals(body.reasoning, { effort: 'high' });
  assertEquals('reasoning_effort' in body, false);
  assertEquals(body.provider, { require_parameters: true });
  assertEquals(body.session_id, 's-1');
  assertEquals(body.web_search_options, {});
  const messages = body.messages as JsonObject[];
  assertEquals(messages[0], {
    role: 'system',
    content: [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  });
  assertEquals(messages[1]?.reasoning_details, signed.details);
  assertEquals(messages[1]?.reasoning, 'Plan.');
});

Deno.test('openRouterOpenAi reads thinking, citation lists, and reasoning to send back', async () => {
  const { call } = setup([
    {
      citations: ['https://a.test', 'https://a.test'],
      choices: [
        {
          delta: {
            thinking: 'Hmm.',
            content: 'Rain.',
            reasoning_details: [{ type: 'reasoning.encrypted', data: 'xyz', index: 0 }],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'stop', native_finish_reason: 'STOP' }] },
  ]);
  const events = await collect(callProtocol(call).complete(request));
  assertEquals(
    events.map((event) => event.type),
    ['thought', 'citation', 'text', 'reasoning', 'done'],
  );
  assertEquals(events[0], { type: 'thought', text: 'Hmm.' });
  assertEquals(events[1], {
    type: 'citation',
    sources: [{ title: 'https://a.test', uri: 'https://a.test', type: 'web' }],
  });
  assertEquals(events[3], {
    type: 'reasoning',
    data: { details: [{ type: 'reasoning.encrypted', data: 'xyz', index: 0 }] },
    origin: { protocol: 'openRouterOpenAi', provider: 'router', apiId: 'm-1' },
  });
});

Deno.test('openRouterOpenAi sends speech as openAi does', async () => {
  const registry = createProviderRegistry();
  registry.register(router, { keySlot: 'main' });
  const provider = registry.require('router', 'tts-1');
  const sent: JsonObject[] = [];
  const call = callProtocol({
    provider,
    binding: checkBinding(
      provider,
      { protocol: 'openRouterOpenAi', provider: 'router', apiId: 'tts-1' },
      'speech',
    ),
    profileType: 'speech',
    vault: { main: 'k-main' },
    fetch: (_input, init) => {
      sent.push(JSON.parse(String(init?.body)) as JsonObject);
      return Promise.resolve(
        new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/mpeg' } }),
      );
    },
    wait: async () => {},
  });
  await collect(call.complete({ ...request, history: [] } as unknown as ProtocolRequest));
  assertEquals(sent[0], { model: 'tts-1', input: 'And tomorrow?' });
});

Deno.test('a busy model moves to the fallback slot once the primary key has had its tries', async () => {
  const seen: (string | null)[] = [];
  const registry = createProviderRegistry();
  const provider = registry.register(router, { keySlot: 'main', fallbackKeySlot: 'spare' });
  const call = callProtocol({
    provider,
    binding: checkBinding(
      provider,
      { protocol: 'openRouterOpenAi', provider: 'router', apiId: 'm-1' },
      'text',
    ),
    profileType: 'text',
    vault: { main: 'main-key', spare: 'spare-key' },
    wait: () => Promise.resolve(),
    fetch: (_input, init) => {
      const auth = new Headers(init?.headers).get('authorization');
      seen.push(auth);
      return Promise.resolve(
        auth === 'Bearer main-key'
          ? new Response('{}', { status: 503 })
          : sse([{ choices: [{ delta: { content: 'Rain.' }, finish_reason: 'stop' }] }]),
      );
    },
  });
  const events = await collect(call.complete(request));
  assertEquals(
    events.map((event) => event.type),
    ['text', 'done'],
  );
  assertEquals(seen.at(-1), 'Bearer spare-key');
  assertEquals(seen.filter((auth) => auth === 'Bearer spare-key').length, 1);
});

Deno.test('a 500 stays on the primary key', async () => {
  const seen: (string | null)[] = [];
  const registry = createProviderRegistry();
  const provider = registry.register(router, { keySlot: 'main', fallbackKeySlot: 'spare' });
  const call = callProtocol({
    provider,
    binding: checkBinding(
      provider,
      { protocol: 'openRouterOpenAi', provider: 'router', apiId: 'm-1' },
      'text',
    ),
    profileType: 'text',
    vault: { main: 'main-key', spare: 'spare-key' },
    wait: () => Promise.resolve(),
    fetch: (_input, init) => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return Promise.resolve(new Response('{}', { status: 500 }));
    },
  });
  const events = await collect(call.complete(request));
  assertEquals(events.at(-1)?.type, 'error');
  assertEquals(new Set(seen), new Set(['Bearer main-key']));
});

Deno.test('a quota refusal backs off on the primary key before the fallback slot, taping every try with its slot', async () => {
  const seen: (string | null)[] = [];
  const taped: unknown[] = [];
  const waits: number[] = [];
  const registry = createProviderRegistry();
  const provider = registry.register(router, { keySlot: 'main', fallbackKeySlot: 'spare' });
  const call = callProtocol({
    provider,
    binding: checkBinding(
      provider,
      { protocol: 'openRouterOpenAi', provider: 'router', apiId: 'm-1' },
      'text',
    ),
    profileType: 'text',
    vault: { main: 'main-key', spare: 'spare-key' },
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    tapUpstream: (row) => {
      if (row.eventType === 'http_request') taped.push(row.keySlot);
    },
    fetch: (_input, init) => {
      const auth = new Headers(init?.headers).get('authorization');
      seen.push(auth);
      return Promise.resolve(
        auth === 'Bearer main-key'
          ? new Response('{}', { status: 429 })
          : sse([{ choices: [{ delta: { content: 'Rain.' }, finish_reason: 'stop' }] }]),
      );
    },
  });
  const events = await collect(call.complete(request));
  assertEquals(
    events.map((event) => event.type),
    ['text', 'done'],
  );
  assertEquals(seen, ['Bearer main-key', 'Bearer main-key', 'Bearer main-key', 'Bearer spare-key']);
  assertEquals(taped, ['main', 'main', 'main', 'spare']);
  assertEquals(waits, [1000, 2000]);
});
