import { assertEquals, assertRejects } from '@std/assert';
import { z } from 'zod';
import { TheoremError } from '../../../src/guardrails/error.ts';
import {
  callProtocol,
  checkBinding,
  createProviderRegistry,
  defineProvider,
  header,
  type ProtocolEvent,
  type TurnRequest,
} from '../../../src/kernel/protocols/mod.ts';
import type { JsonObject } from '../../../src/kernel/provider-contract.ts';
import { geminiInteractions } from '../../../src/providers/gemini/interactions-protocol.ts';

// Rows follow the shapes recorded from gemini-3.8-flash and gemini-3.1-flash-lite (23 and
// 25/09/2026); ids, text and signatures are synthetic.

const google = defineProvider({
  id: 'google-test',
  name: 'Google',
  description: 'A test Gemini host.',
  key: z.string(),
  authorize: header('x-goog-api-key'),
  serves: () => [{ protocol: geminiInteractions, baseUrl: 'https://gemini.test/v1beta' }],
});

function sse(rows: JsonObject[]): Response {
  const text = rows.map((row) => `data: ${JSON.stringify(row)}\n\n`).join('');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

function row(eventType: string, fields: JsonObject): JsonObject {
  return { event_type: eventType, ...fields };
}

const request = {
  system: 'Be brief.',
  input: [{ type: 'text', text: 'Weather in Porto and Faro?' }],
  builtins: [{ id: 'googleSearch' }],
  structured: null,
  image: null,
} as unknown as TurnRequest;

function run(reply: Response, turn: Partial<TurnRequest> = {}, options: JsonObject = {}) {
  const sent: { url: string; headers: Headers; body: JsonObject }[] = [];
  const registry = createProviderRegistry();
  registry.register(google, { keySlot: 'main' });
  const provider = registry.require('google-test', 'gemini-3.8-flash');
  const call = callProtocol({
    provider,
    binding: checkBinding(
      provider,
      {
        protocol: 'geminiInteractions',
        provider: 'google-test',
        apiId: 'gemini-3.8-flash',
        options,
        builtInTools: ['googleSearch'],
      },
      'text',
    ),
    profileType: 'text',
    vault: { main: 'k-main' },
    fetch: async (input, init) => {
      sent.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as JsonObject,
      });
      return reply.clone();
    },
    wait: async () => {},
  });
  return { sent, events: () => Array.fromAsync(call.complete({ ...request, ...turn })) };
}

function withoutIds(events: ProtocolEvent[]): unknown[] {
  return events.map((event) =>
    event.type === 'tool_call'
      ? { ...event, call: { ...event.call, callId: '<minted>' } }
      : event.type === 'reasoning'
        ? { type: event.type, data: event.data, origin: event.origin }
        : event,
  );
}

Deno.test('geminiInteractions streams at /interactions with the key in its header and the built-in it wrote', async () => {
  const { sent, events } = run(
    sse([
      row('interaction.created', { interaction: { id: 'v1_int' } }),
      row('step.start', { index: 0, step: { type: 'model_output' } }),
      row('step.delta', { index: 0, delta: { type: 'text', text: 'Sunny.' } }),
      row('step.stop', { index: 0 }),
      row('interaction.completed', {
        interaction: {
          id: 'v1_int',
          status: 'completed',
          usage: { total_input_tokens: 4, total_output_tokens: 2 },
        },
      }),
    ]),
  );
  const out = await events();
  assertEquals(sent[0]?.url, 'https://gemini.test/v1beta/interactions?alt=sse');
  assertEquals(sent[0]?.headers.get('x-goog-api-key'), 'k-main');
  assertEquals(sent[0]?.body.model, 'gemini-3.8-flash');
  assertEquals(sent[0]?.body.tools, [{ type: 'google_search' }]);
  assertEquals(sent[0]?.body.store, undefined);
  assertEquals(
    out.filter((event) => event.type === 'text'),
    [{ type: 'text', text: 'Sunny.' }],
  );
  assertEquals(out.at(-1)?.type, 'done');
});

Deno.test('a thought signature becomes reasoning for its call, and goes back on that call', async () => {
  const { events } = run(
    sse([
      row('step.start', { index: 0, step: { type: 'thought' } }),
      row('step.delta', { index: 0, delta: { signature: 'sig', type: 'thought_signature' } }),
      row('step.stop', { index: 0 }),
      row('step.start', {
        index: 1,
        step: { id: 'call_1', type: 'function_call', name: 'geocode_city', arguments: {} },
      }),
      row('step.delta', {
        index: 1,
        delta: { arguments: '{"city":"Porto"}', type: 'arguments_delta' },
      }),
      row('step.stop', { index: 1 }),
      row('step.start', {
        index: 2,
        step: { id: 'call_2', type: 'function_call', name: 'geocode_city', arguments: {} },
      }),
      row('step.delta', {
        index: 2,
        delta: { arguments: '{"city":"Faro"}', type: 'arguments_delta' },
      }),
      row('step.stop', { index: 2 }),
      row('interaction.completed', { interaction: { id: 'v1_int', status: 'requires_action' } }),
    ]),
  );
  const out = withoutIds(await events()).filter(
    (event) =>
      (event as ProtocolEvent).type === 'reasoning' ||
      (event as ProtocolEvent).type === 'tool_call',
  );
  assertEquals(out, [
    {
      type: 'reasoning',
      data: { call: 0, signature: 'sig' },
      origin: {
        protocol: 'geminiInteractions',
        provider: 'google-test',
        apiId: 'gemini-3.8-flash',
      },
    },
    {
      type: 'tool_call',
      call: {
        callId: '<minted>',
        wireCallId: 'call_1',
        name: 'geocode_city',
        arguments: { city: 'Porto' },
      },
    },
    {
      type: 'tool_call',
      call: {
        callId: '<minted>',
        wireCallId: 'call_2',
        name: 'geocode_city',
        arguments: { city: 'Faro' },
      },
    },
  ]);
  const replay = run(
    sse([row('interaction.completed', { interaction: { status: 'completed' } })]),
    {
      history: [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'a', type: 'function', function: { name: 'geocode_city', arguments: '{}' } },
            { id: 'b', type: 'function', function: { name: 'geocode_city', arguments: '{}' } },
          ],
          reasoning: [
            { data: { call: 0, signature: 'sig' }, origin: { protocol: 'geminiInteractions' } },
            { data: { call: 1, signature: 'other' }, origin: { protocol: 'openRouter' } },
          ],
        },
      ],
    },
  );
  await replay.events();
  const steps = replay.sent[0]?.body.input as JsonObject[];
  assertEquals(
    steps.filter((step) => step.type === 'thought'),
    [{ type: 'thought', signature: 'sig' }],
  );
});

Deno.test('a stored interaction continues from its id and sends only what came after', async () => {
  const { sent, events } = run(
    Response.json({
      id: 'v1_next',
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Hi' }] }],
    }),
    {
      stream: false,
      state: { interactionId: 'v1_prev' },
      stateHistoryLength: 2,
      history: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
      ],
    },
    { store: true, persistViaInteractionId: true },
  );
  const out = await events();
  assertEquals(sent[0]?.url, 'https://gemini.test/v1beta/interactions');
  assertEquals(sent[0]?.body.previous_interaction_id, 'v1_prev');
  assertEquals((sent[0]?.body.input as JsonObject[] | undefined)?.length, 1);
  const done = out.at(-1);
  assertEquals(done?.type === 'done' ? done.state : undefined, { interactionId: 'v1_next' });
});

Deno.test('a refused key is an auth error and a stream error row is thrown', async () => {
  const refused = run(
    Response.json(
      {
        error: {
          code: 400,
          message: 'API key not valid.',
          status: 'INVALID_ARGUMENT',
          details: [{ reason: 'API_KEY_INVALID' }],
        },
      },
      { status: 400 },
    ),
  );
  const error = await assertRejects(() => refused.events(), TheoremError);
  assertEquals(error.kind, 'auth');
  const quota = run(
    sse([{ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }]),
  );
  const limited = await assertRejects(() => quota.events(), TheoremError);
  assertEquals(limited.kind, 'rate_limit');
});
