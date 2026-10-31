import { assertEquals, assertMatch, assertThrows } from '@std/assert';
import { z } from 'zod';
import { TheoremError } from '../../../src/guardrails/error.ts';
import type { JsonObject } from '../../../src/kernel/json.ts';
import {
  bearer,
  type CallSetup,
  callProtocol,
  checkBinding,
  createProviderRegistry,
  defineProvider,
  type ProtocolEvent,
  type ProtocolRequest,
  type Registration,
} from '../../../src/kernel/protocols/mod.ts';
import { openAi } from '../../../src/providers/open-ai/protocol.ts';
import { failureOf } from '../../fixtures/failure.ts';

const compatible = defineProvider({
  id: 'compatible',
  name: 'Compatible',
  description: 'A server that speaks Chat Completions.',
  key: z.string(),
  authorize: bearer(),
  serves: () => [{ protocol: openAi, baseUrl: 'https://compatible.test/v1' }],
});

function sse(rows: JsonObject[]): Response {
  const text = `${rows.map((row) => `data: ${JSON.stringify(row)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

function setup(answer: (count: number) => Response) {
  const sent: { url: string; auth: string | null; body: JsonObject }[] = [];
  const send: typeof fetch = (input, init) => {
    sent.push({
      url: String(input),
      auth: new Headers(init?.headers).get('authorization'),
      body: JSON.parse(String(init?.body)) as JsonObject,
    });
    return Promise.resolve(answer(sent.length));
  };
  const registry = createProviderRegistry();
  registry.register(compatible, { keySlot: 'main', fallbackKeySlot: 'spare' });
  const provider = registry.require('compatible', 'm-1');
  const call: CallSetup = {
    provider,
    binding: checkBinding(
      provider,
      { protocol: 'openAi', provider: 'compatible', apiId: 'm-1' },
      'text',
    ),
    profileType: 'text',
    vault: { main: 'k-main', spare: 'k-spare' },
    fetch: send,
    wait: async () => {},
  };
  return { sent, call };
}

const request = {
  system: 'Be brief.',
  input: [{ type: 'text', text: 'Weather in Lisbon?' }],
  builtins: [],
  structured: null,
  image: null,
  thinking: 'low',
  wireTools: [{ name: 'weather', description: 'Weather.', parameters: { type: 'object' } }],
} as unknown as ProtocolRequest;

async function collect(events: AsyncIterable<ProtocolEvent>): Promise<ProtocolEvent[]> {
  const out: ProtocolEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

Deno.test('openAi streams text, thinking, drafts, and a call under Theorem’s id', async () => {
  const { sent, call } = setup(() =>
    sse([
      { id: 'r-1', model: 'm-1', choices: [{ delta: { reasoning_content: 'Hmm.' } }] },
      { choices: [{ delta: { content: 'Checking.' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'wire-1', function: { name: 'weather', arguments: '{"ci' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Lisbon"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } },
    ]),
  );
  const events = await collect(callProtocol(call).complete(request));
  assertEquals(sent[0]?.url, 'https://compatible.test/v1/chat/completions');
  assertEquals(sent[0]?.auth, 'Bearer k-main');
  assertEquals(sent[0]?.body.reasoning_effort, 'low');
  assertEquals(sent[0]?.body.stream_options, { include_usage: true });
  assertEquals(
    events.map((event) => event.type),
    ['response', 'thought', 'text', 'tool_draft', 'tool_draft', 'tokens', 'tool_call', 'done'],
  );
  const drafted = events.filter((event) => event.type === 'tool_draft');
  const made = events.find((event) => event.type === 'tool_call');
  if (made?.type !== 'tool_call') throw new Error('no call');
  assertMatch(made.call.callId, /^[A-Za-z0-9]{24}$/);
  assertEquals(made.call.wireCallId, 'wire-1');
  assertEquals(made.call.arguments, { city: 'Lisbon' });
  for (const draft of drafted) assertEquals('callId' in draft && draft.callId, made.call.callId);
  assertEquals(events.at(-1), { type: 'done', stop: { kind: 'tool', native: 'tool_calls' } });
});

Deno.test('openAi reads a whole reply: citations and a structured answer', async () => {
  const { sent, call } = setup(
    () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"ok":true}',
                annotations: [
                  { type: 'url_citation', url_citation: { url: 'https://a.test', title: 'A' } },
                ],
              },
              finish_reason: 'stop',
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  const structured = {
    ...request,
    stream: false,
    wireTools: undefined,
    structured: { id: 'answer', jsonSchema: { type: 'object' } },
  } as unknown as ProtocolRequest;
  const events = await collect(callProtocol(call).complete(structured));
  assertEquals(sent[0]?.body.stream, false);
  assertEquals('tools' in (sent[0]?.body ?? {}), false);
  assertEquals(events, [
    { type: 'text', text: '{"ok":true}' },
    { type: 'citation', sources: [{ title: 'A', uri: 'https://a.test', type: 'web' }] },
    { type: 'structured', structured: { ok: true } },
    { type: 'done', stop: { kind: 'completed', native: 'stop' } },
  ]);
});

Deno.test('openAi: a quota error row before any output falls back to the spare key', async () => {
  const { sent, call } = setup((count) =>
    count === 1
      ? sse([{ error: { code: 429, message: 'Slow down.' } }])
      : sse([{ choices: [{ delta: { content: 'Hi.' }, finish_reason: 'stop' }] }]),
  );
  const events = await collect(callProtocol(call).complete(request));
  assertEquals(
    sent.map((entry) => entry.auth),
    ['Bearer k-main', 'Bearer k-spare'],
  );
  assertEquals(
    events.map((event) => event.type),
    ['text', 'done'],
  );
});

Deno.test('openAi: a refused request names the reason the body gives, and the provider’s own detail', async () => {
  const body = {
    error: {
      message: 'Provider returned error',
      code: 400,
      metadata: { raw: 'data did not match any variant', provider_name: 'Nvidia' },
    },
  };
  const { call } = setup(() => new Response(JSON.stringify(body), { status: 400 }));
  const error = failureOf(await collect(callProtocol(call).complete(request)));
  assertEquals(error.kind, 'unsupported');
  assertEquals(
    error.message,
    'Chat Completions HTTP 400: Provider returned error {"metadata":{"raw":"data did not match any variant","provider_name":"Nvidia"}}',
  );
});

Deno.test('openAi: an error row keeps the provider’s own detail', async () => {
  const { call } = setup(() =>
    sse([{ error: { code: 400, message: 'Bad input.', metadata: { raw: 'no images here' } } }]),
  );
  const error = failureOf(await collect(callProtocol(call).complete(request)));
  assertEquals(error.message, 'Bad input. {"metadata":{"raw":"no images here"}}');
});

Deno.test('a key slot on a provider that takes no key is refused', () => {
  const keyless = defineProvider({
    ...compatible,
    id: 'keyless',
    key: undefined,
    authorize: undefined,
  });
  assertThrows(
    () => createProviderRegistry().register(keyless, { keySlot: 'main' }),
    TheoremError,
    "Provider 'keyless' takes no key",
  );
});

Deno.test('openAi never sends reasoning another protocol saved', async () => {
  const { sent, call } = setup(() =>
    sse([{ choices: [{ delta: { content: 'Ok.' }, finish_reason: 'stop' }] }]),
  );
  const replayed = {
    ...request,
    history: [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'weather', content: 'Sunny.' },
    ],
    state: {
      replay: [{ callIds: ['c1'], details: [{ type: 'reasoning.text', text: 'x' }], content: 'x' }],
    },
  } as unknown as ProtocolRequest;
  await collect(callProtocol(call).complete(replayed));
  const messages = sent[0]?.body.messages as JsonObject[];
  assertEquals(
    messages.some((message) => 'reasoning_details' in message || 'reasoning' in message),
    false,
  );
});

Deno.test('openAi reads text aloud on /audio/speech; raw PCM comes back as WAV', async () => {
  const registry = createProviderRegistry();
  registry.register(compatible, { keySlot: 'main' });
  const provider = registry.require('compatible', 'tts-1');
  const answers = [
    new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { 'content-type': 'audio/mpeg', 'x-generation-id': 'gen-tts-mp3' },
    }),
    new Response(new Uint8Array([0, 0, 1, 0]), {
      headers: { 'content-type': 'audio/pcm;rate=24000;channels=1' },
    }),
  ];
  const sent: JsonObject[] = [];
  const call = callProtocol({
    provider,
    binding: checkBinding(
      provider,
      { protocol: 'openAi', provider: 'compatible', apiId: 'tts-1' },
      'speech',
    ),
    profileType: 'speech',
    vault: { main: 'k-main' },
    fetch: (_input, init) => {
      sent.push(JSON.parse(String(init?.body)) as JsonObject);
      return Promise.resolve(answers.shift() as Response);
    },
    wait: async () => {},
  });
  const spoken = {
    ...request,
    wireTools: undefined,
    speech: { voice: 'alloy', style: 'Calm.' },
  } as unknown as ProtocolRequest;
  const mp3 = await collect(call.complete(spoken));
  assertEquals(sent[0], {
    model: 'tts-1',
    input: 'Weather in Lisbon?',
    voice: 'alloy',
    instructions: 'Calm.',
  });
  assertEquals(mp3, [
    { type: 'response', response: { id: 'gen-tts-mp3' } },
    { type: 'media', media: { mimeType: 'audio/mpeg', data: 'AQIDBA==' } },
    { type: 'done', stop: { kind: 'completed' } },
  ]);
  const pcm = await collect(call.complete(spoken));
  assertEquals(
    pcm.map((event) => event.type),
    ['media', 'done'],
  );
  assertEquals(pcm[0]?.type === 'media' && pcm[0].media.mimeType, 'audio/wav');
});

async function refused(registration: Registration<undefined>, vault: Record<string, string>) {
  const auths: (string | null)[] = [];
  const registry = createProviderRegistry();
  const provider = registry.register(compatible, registration);
  const call = callProtocol({
    provider,
    binding: checkBinding(
      provider,
      { protocol: 'openAi', provider: 'compatible', apiId: 'm-1' },
      'text',
    ),
    profileType: 'text',
    vault,
    fetch: (_input, init) => {
      auths.push(new Headers(init?.headers).get('authorization'));
      return Promise.resolve(new Response('{}', { status: 429 }));
    },
    wait: async () => {},
  });
  const error = failureOf(await collect(call.complete(request)));
  return { auths, error };
}

Deno.test('with no fallback slot, a quota refusal stands once the primary key’s backoff runs out', async () => {
  const { auths, error } = await refused({ keySlot: 'main' }, { main: 'k-main' });
  assertEquals(error.kind, 'rate_limit');
  assertEquals(auths, ['Bearer k-main', 'Bearer k-main', 'Bearer k-main']);
});

Deno.test('a fallback slot is tried by its name, even when it holds the same key', async () => {
  const { auths, error } = await refused(
    { keySlot: 'main', fallbackKeySlot: 'spare' },
    { main: 'k-main', spare: 'k-main' },
  );
  assertEquals(error.kind, 'rate_limit');
  assertEquals(auths, Array(6).fill('Bearer k-main'));
});

Deno.test('a fallback slot with no key in the vault is not tried, and the quota refusal stands', async () => {
  const { auths, error } = await refused(
    { keySlot: 'main', fallbackKeySlot: 'absent' },
    { main: 'k-main' },
  );
  assertEquals(error.kind, 'rate_limit');
  assertEquals(auths, ['Bearer k-main', 'Bearer k-main', 'Bearer k-main']);
});
