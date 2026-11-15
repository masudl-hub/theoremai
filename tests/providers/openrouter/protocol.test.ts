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

Deno.test('openRouterOpenAi sends the host routing beside its own, and the host wins', async () => {
  const provider = { only: ['gmicloud/fp8'], allow_fallbacks: false };
  const { sent, call } = setup(
    [{ choices: [{ delta: { content: 'Rain.' }, finish_reason: 'stop' }] }],
    { provider },
  );
  await collect(callProtocol(call).complete(request));
  assertEquals(sent[0]?.provider, { require_parameters: true, ...provider });

  const off = setup([{ choices: [{ delta: { content: 'Rain.' }, finish_reason: 'stop' }] }], {
    provider: { require_parameters: false },
  });
  await collect(callProtocol(off.call).complete(request));
  assertEquals(off.sent[0]?.provider, { require_parameters: false });
});

Deno.test('openRouterOpenAi refuses a routing field it does not know', () => {
  const parsed = openRouterOpenAi.options.safeParse({ provider: { onlyy: ['a'] } });
  assertEquals(parsed.success, false);
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
        new Response(new Uint8Array([1]), {
          headers: {
            'content-type': 'audio/mpeg',
            'x-generation-id': 'gen-tts-openrouter',
          },
        }),
      );
    },
    wait: async () => {},
  });
  const events = await collect(
    call.complete({ ...request, history: [] } as unknown as ProtocolRequest),
  );
  assertEquals(sent[0], { model: 'tts-1', input: 'And tomorrow?' });
  assertEquals(events[0], { type: 'response', response: { id: 'gen-tts-openrouter' } });
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

const ROUTING_404 = (step: string, kind: string) => ({
  error: {
    message: `No endpoints found that support ${kind}`,
    code: 404,
    metadata: { routing_funnel: [], failed_routing_step: step },
  },
});

Deno.test('a model with no endpoint for a kind of file refuses every file of that kind', () => {
  const cases = [
    ['Filter by Image Support', 'image input', 'image/*'],
    ['Filter by Input Audio Support', 'input audio', 'audio/*'],
    ['Filter by Input Video Support', 'input video', 'video/*'],
  ] as const;
  for (const [step, kind, refused] of cases) {
    const err = openRouterOpenAi.error?.({
      status: 404,
      body: ROUTING_404(step, kind),
      headers: new Headers(),
    });
    assertEquals(err?.kind, 'unsupported');
    assertEquals(err?.refusedMedia, [refused]);
    assertEquals(err?.message.includes(`No endpoints found that support ${kind}`), true);
  }
});

Deno.test('a refusal that names no kind of file names none, and openAi never names one', () => {
  const headers = new Headers();
  const other = ROUTING_404('Filter by Tool Support', 'tool use');
  assertEquals(
    openRouterOpenAi.error?.({ status: 404, body: other, headers })?.refusedMedia,
    undefined,
  );
  const raw = { error: { message: 'Provider returned error', code: 400, metadata: { raw: 'x' } } };
  assertEquals(
    openRouterOpenAi.error?.({ status: 400, body: raw, headers })?.refusedMedia,
    undefined,
  );
  assertEquals(
    openRouterOpenAi.error?.({ status: 404, body: 'not json', headers })?.refusedMedia,
    undefined,
  );
  const image = ROUTING_404('Filter by Image Support', 'image input');
  assertEquals(openAi.error?.({ status: 404, body: image, headers })?.refusedMedia, undefined);
});

const UPSTREAM_AUDIO = {
  error: {
    message:
      'Upstream error from Nvidia: Unsupported audio format: send WAV, MP3, FLAC or Ogg (Vorbis/Opus) audio.',
    code: 400,
    metadata: { error_type: 'invalid_request' },
  },
};

type Failed = { errorKind?: string; refusedMedia?: string[] };

async function failure(rows: JsonObject[]): Promise<unknown> {
  try {
    const events = await collect(callProtocol(setup(rows).call).complete(request));
    return events.find((event) => event.type === 'error');
  } catch (err) {
    return err;
  }
}

Deno.test('an upstream that cannot decode a clip refuses every audio file, before any reply', async () => {
  const first = (await failure([UPSTREAM_AUDIO])) as Failed;
  assertEquals(first.errorKind, 'unsupported');
  assertEquals(first.refusedMedia, ['audio/*']);
  const later = (await failure([
    { id: 'r1', choices: [{ delta: { content: 'Hi' } }] },
    UPSTREAM_AUDIO,
  ])) as Failed;
  assertEquals(later.errorKind, 'unavailable');
  assertEquals(later.refusedMedia, undefined);
  const other = (await failure([
    { error: { message: 'Unsupported parameter: seed', code: 400 } },
  ])) as Failed;
  assertEquals(other.errorKind, 'unsupported');
  assertEquals(other.refusedMedia, undefined);
  const busy = (await failure([
    { error: { message: 'Unsupported audio format', code: 503 } },
  ])) as Failed;
  assertEquals(busy.errorKind, 'busy');
  assertEquals(busy.refusedMedia, undefined);
  const headers = new Headers();
  assertEquals(
    openRouterOpenAi.error?.({ status: 400, body: UPSTREAM_AUDIO, headers })?.refusedMedia,
    ['audio/*'],
  );
});
