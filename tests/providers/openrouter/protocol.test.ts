import { assertEquals } from '@std/assert';
import { z } from 'zod';
import {
  bearer,
  type CallSetup,
  callProtocol,
  carriesTo,
  checkBinding,
  createProviderRegistry,
  defineProvider,
  type ProtocolEvent,
  type TurnRequest,
} from '../../../src/kernel/protocols/mod.ts';
import type { JsonObject } from '../../../src/kernel/provider-contract.ts';
import { openAi } from '../../../src/providers/open-ai/protocol.ts';
import { openRouter } from '../../../src/providers/openrouter/protocol.ts';

const router = defineProvider({
  id: 'router',
  name: 'Router',
  description: 'A gateway that speaks OpenRouter Chat Completions.',
  key: z.string(),
  authorize: bearer(),
  serves: () => [{ protocol: openRouter, baseUrl: 'https://router.test/api/v1' }],
});

function sse(rows: JsonObject[]): Response {
  const text = rows.map((row) => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

function setup(rows: JsonObject[], options: JsonObject = {}) {
  const sent: JsonObject[] = [];
  const send: typeof fetch = async (_input, init) => {
    sent.push(JSON.parse(String(init?.body)) as JsonObject);
    return sse(rows);
  };
  const registry = createProviderRegistry();
  registry.register(router, { keySlot: 'main' });
  const provider = registry.require('router', 'm-1');
  const call: CallSetup = {
    provider,
    binding: checkBinding(
      provider,
      {
        protocol: 'openRouter',
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
      reasoning: [{ data: signed, origin: { protocol: 'openRouter' } }],
    },
    { role: 'tool', tool_call_id: 'c1', name: 'weather', content: 'Sunny.' },
  ],
} as unknown as TurnRequest;

async function collect(events: AsyncIterable<ProtocolEvent>): Promise<ProtocolEvent[]> {
  const out: ProtocolEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

Deno.test('openRouter extends openAi and only it takes OpenRouter reasoning back', () => {
  assertEquals(openRouter.lineage, ['openRouter', 'openAi']);
  assertEquals(openRouter.endpoints.text, '/chat/completions');
  assertEquals(carriesTo('openRouter', openAi), false);
});

Deno.test('openRouter writes its body: effort, routing, cache, session, web search, reasoning', async () => {
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

Deno.test('openRouter reads thinking, citation lists and reasoning to send back', async () => {
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
    origin: { protocol: 'openRouter', provider: 'router', apiId: 'm-1' },
  });
});

Deno.test('openRouter sends speech as openAi does', async () => {
  const registry = createProviderRegistry();
  registry.register(router, { keySlot: 'main' });
  const provider = registry.require('router', 'tts-1');
  const sent: JsonObject[] = [];
  const call = callProtocol({
    provider,
    binding: checkBinding(
      provider,
      { protocol: 'openRouter', provider: 'router', apiId: 'tts-1' },
      'speech',
    ),
    profileType: 'speech',
    vault: { main: 'k-main' },
    fetch: async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)) as JsonObject);
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/mpeg' } });
    },
    wait: async () => {},
  });
  await collect(call.complete({ ...request, history: [] } as unknown as TurnRequest));
  assertEquals(sent[0], { model: 'tts-1', input: 'And tomorrow?' });
});
