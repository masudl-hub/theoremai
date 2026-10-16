import { assertEquals, assertMatch, assertThrows } from '@std/assert';
import { z } from 'zod';
import { TheoremError } from '../../../src/guardrails/error.ts';
import {
  bearer,
  type CallSetup,
  callProtocol,
  checkBinding,
  createProviderRegistry,
  defineProvider,
  type ProtocolEvent,
  type TurnRequest,
} from '../../../src/kernel/protocols/mod.ts';
import type { JsonObject } from '../../../src/kernel/provider-contract.ts';
import { openAi } from '../../../src/providers/open-ai/protocol.ts';

const compatible = defineProvider({
  id: 'compatible',
  name: 'Compatible',
  description: 'A server that speaks Chat Completions.',
  key: z.string(),
  authorize: bearer(),
  serves: () => [{ protocol: openAi, baseUrl: 'https://compatible.test/v1' }],
});

function sse(rows: JsonObject[]): Response {
  const text = rows.map((row) => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

function setup(answer: (count: number) => Response) {
  const sent: { url: string; auth: string | null; body: JsonObject }[] = [];
  const send: typeof fetch = async (input, init) => {
    sent.push({
      url: String(input),
      auth: new Headers(init?.headers).get('authorization'),
      body: JSON.parse(String(init?.body)) as JsonObject,
    });
    return answer(sent.length);
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
} as unknown as TurnRequest;

async function collect(events: AsyncIterable<ProtocolEvent>): Promise<ProtocolEvent[]> {
  const out: ProtocolEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

Deno.test('openAi streams text, thinking, drafts and a call under Theorem’s id', async () => {
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
  } as unknown as TurnRequest;
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
