import { assertEquals, assertRejects } from '@std/assert';
import { z } from 'zod';
import { TheoremError } from '../../../src/guardrails/error.ts';
import type { JsonObject } from '../../../src/kernel/json.ts';
import {
  callProtocol,
  checkBinding,
  createProviderRegistry,
  defineProvider,
  header,
  type ProtocolEvent,
  type ProtocolRequest,
} from '../../../src/kernel/protocols/mod.ts';
import { protocolRequest } from '../../../src/kernel/provider-runtime.ts';
import type { KeyVault } from '../../../src/kernel/registry/vault.ts';
import type { ModelRequest } from '../../../src/kernel/types.ts';
import { bytesToBase64 } from '../../../src/kernel/util/base64.ts';
import { geminiInteractions } from '../../../src/providers/gemini/interactions-protocol.ts';
import { wrapPcmAsWav } from '../../../src/providers/shared/pcm.ts';
import { failureOf } from '../../fixtures/failure.ts';

// Rows follow the shapes recorded from gemini-3.8-flash and gemini-3.1-flash-lite (23 and
// 25/09/2026); ids, text, and signatures are synthetic.

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
} as unknown as ProtocolRequest;

type Reply = Response | (() => Promise<Response>);

interface Host {
  profileType?: 'text' | 'image' | 'speech';
  builtInTools?: string[];
  vault?: KeyVault;
  apiId?: string;
}

function run(
  reply: Reply,
  turn: Partial<ProtocolRequest> = {},
  options: JsonObject = {},
  host: Host = {},
) {
  const sent: { url: string; headers: Headers; body: JsonObject }[] = [];
  const profileType = host.profileType ?? 'text';
  const registry = createProviderRegistry();
  registry.register(google, { keySlot: 'main' });
  const apiId = host.apiId ?? 'gemini-3.8-flash';
  const provider = registry.require('google-test', apiId);
  const call = callProtocol({
    provider,
    binding: checkBinding(
      provider,
      {
        protocol: 'geminiInteractions',
        provider: 'google-test',
        apiId,
        options,
        builtInTools: host.builtInTools ?? ['googleSearch'],
      },
      profileType,
    ),
    profileType,
    vault: host.vault ?? { main: 'k-main' },
    fetch: async (input, init) => {
      sent.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as JsonObject,
      });
      return reply instanceof Response ? reply.clone() : await reply();
    },
    wait: async () => {},
  });
  return { sent, events: () => Array.fromAsync(call.complete({ ...request, ...turn })) };
}

/** Each event's type, an error as its message. */
function summary(events: ProtocolEvent[]): string[] {
  return events.map((event) =>
    event.type === 'error' ? `error:${event.errorInternal}` : event.type,
  );
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

Deno.test('a turn that asks for fewer built-ins than the binding names writes only those it asked for', async () => {
  const done = sse([
    row('interaction.completed', { interaction: { id: 'v1_int', status: 'completed' } }),
  ]);
  const host = { builtInTools: ['urlContext', 'googleSearch'] };
  const { sent, events } = run(done, { builtins: [] }, {}, host);
  assertEquals((await events()).at(-1)?.type, 'done');
  assertEquals(sent[0]?.body.tools, undefined);
});

Deno.test('a built-in the turn asks for that the protocol does not write is refused, and nothing is posted', async () => {
  const { sent, events } = run(
    sse([]),
    { builtins: [{ id: 'webSearch' }] },
    {},
    {
      builtInTools: ['webSearch'],
    },
  );
  const error = await assertRejects(events, TheoremError);
  assertEquals(error.kind, 'unsupported');
  assertEquals(sent, []);
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
  // The kernel hands the protocol only the reasoning its own lineage wrote.
  const history: ModelRequest['history'] = [
    { role: 'user', content: 'Weather?' },
    {
      role: 'assistant',
      tool_calls: [
        { id: 'a', type: 'function', function: { name: 'geocode_city', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'geocode_city', arguments: '{}' } },
      ],
      reasoning: [
        { data: { call: 0, signature: 'sig' }, origin: { protocol: 'geminiInteractions' } },
        { data: { call: 1, signature: 'other' }, origin: { protocol: 'openRouterOpenAi' } },
      ],
    },
  ];
  const replay = run(
    sse([row('interaction.completed', { interaction: { status: 'completed' } })]),
    protocolRequest({ ...request, history } as ModelRequest, geminiInteractions, {}),
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

Deno.test('a refused key ends the call as an auth error, and a stream error row as its kind', async () => {
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
  assertEquals(failureOf(await refused.events()).kind, 'auth');
  const quota = run(
    sse([{ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }]),
  );
  assertEquals(failureOf(await quota.events()).kind, 'rate_limit');
});

Deno.test("a refusal streamed as an SSE error event is read for Google's message", async () => {
  const body = `event: error\ndata: ${JSON.stringify({ error: { code: 400, message: 'Missing thought signature.', status: 'INVALID_ARGUMENT' } })}\n\n`;
  const refused = run(
    new Response(body, { status: 400, headers: { 'content-type': 'text/event-stream' } }),
  );
  const error = failureOf(await refused.events());
  assertEquals(
    [error.kind, error.message],
    ['unsupported', 'INVALID_ARGUMENT: Missing thought signature.'],
  );
});

const COMBINED_ERROR = "'google_maps' and 'google_search' cannot be combined in the same request.";

Deno.test('an error the reply states ends the call with its message, buffered or streamed; a 500 is unavailable, a lost fetch network', async () => {
  const stated = { error: { code: 'invalid_request', message: COMBINED_ERROR } };
  const buffered = run(Response.json(stated), { stream: false });
  assertEquals(failureOf(await buffered.events()).message, COMBINED_ERROR);
  const streamed = run(sse([{ event_type: 'error', ...stated }]));
  assertEquals(failureOf(await streamed.events()).message, COMBINED_ERROR);
  const failed = run(new Response('nope', { status: 500 }));
  const error = failureOf(await failed.events());
  assertEquals([error.kind, error.message], ['unavailable', 'Gemini HTTP 500']);
  const unreachable = run(() => Promise.reject(new TypeError('fetch failed: dns')));
  const lost = failureOf(await unreachable.events());
  assertEquals([lost.kind, lost.message], ['network', 'fetch failed: dns']);
});

Deno.test('a slot with no key in the vault is an auth error, and nothing is posted', async () => {
  const { sent, events } = run(sse([]), {}, {}, { vault: {} });
  assertEquals((await assertRejects(() => events(), TheoremError)).kind, 'auth');
  assertEquals(sent.length, 0);
});

Deno.test('an abort while reading is rethrown as it is', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.error(new DOMException('The operation was aborted.', 'AbortError'));
    },
  });
  const { events } = run(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  const error = await assertRejects(() => events());
  assertEquals((error as Error).name, 'AbortError');
});

Deno.test('a streamed reply gives its thought and text, then the structured value the text holds', async () => {
  const { events } = run(
    sse([
      row('step.start', { index: 0, step: { type: 'thought' } }),
      row('step.delta', {
        index: 0,
        delta: { type: 'thought_summary', content: { type: 'text', text: 'hmm' } },
      }),
      row('step.stop', { index: 0 }),
      row('step.start', { index: 1, step: { type: 'model_output' } }),
      row('step.delta', { index: 1, delta: { type: 'text', text: '{"message":"ok"}' } }),
      row('step.stop', { index: 1 }),
      row('interaction.completed', { interaction: { id: 'v1_int', status: 'completed' } }),
    ]),
    {
      builtins: [],
      structured: {
        id: 'reply',
        jsonSchema: { type: 'object', properties: { message: { type: 'string' } } },
      },
    },
    {},
    { builtInTools: [] },
  );
  assertEquals(await events(), [
    { type: 'thought', text: 'hmm' },
    { type: 'text', text: '{"message":"ok"}' },
    { type: 'response', response: { id: 'v1_int' } },
    { type: 'structured', structured: { message: 'ok' } },
    { type: 'done', stop: { kind: 'completed', native: 'completed' } },
  ]);
});

Deno.test('a stream cut off before the interaction reports a status stops as stream_incomplete', async () => {
  const { events } = run(
    sse([
      row('interaction.created', {
        interaction: { id: 'v1_cut', status: 'in_progress', model: 'gemini-test-flash' },
      }),
      row('step.start', { index: 0, step: { type: 'model_output' } }),
      row('step.delta', { index: 0, delta: { type: 'text', text: 'Checking.' } }),
      row('step.stop', { index: 0 }),
      row('step.start', {
        index: 1,
        step: { id: 'call_7', name: 'get_soil_moisture', arguments: {}, type: 'function_call' },
      }),
    ]),
  );
  const out = await events();
  assertEquals(summary(out), ['response', 'text', 'evidence', 'done']);
  // `interaction.created` named the response before any output, so the cut stream still does.
  assertEquals(out[0], {
    type: 'response',
    response: { id: 'v1_cut', model: 'gemini-test-flash' },
  });
  const cut = out[2]?.type === 'evidence' ? out[2].evidence : undefined;
  assertEquals(cut?.partial, true);
  assertEquals(cut?.kind === 'provider_step' ? cut.step : undefined, 'function_call');
  assertEquals(out[3], { type: 'done', stop: { kind: 'stream_incomplete' } });
});

Deno.test('a stream row that is not a JSON object is an error that ends the turn', async () => {
  const { events } = run(
    new Response('data: not json\n\n', { headers: { 'content-type': 'text/event-stream' } }),
  );
  assertEquals(summary(await events()), ['error:Interactions stream row was not a JSON object']);
});

Deno.test('an empty stream stops as stream_incomplete; rows after [DONE] are ignored', async () => {
  const empty = run(new Response(null, { headers: { 'content-type': 'text/event-stream' } }));
  assertEquals(await empty.events(), [{ type: 'done', stop: { kind: 'stream_incomplete' } }]);
  const completed = row('interaction.completed', {
    interaction: { id: 'v1_int', status: 'completed' },
  });
  const late = row('step.delta', { index: 0, delta: { type: 'text', text: 'late' } });
  const after = run(
    new Response(
      `data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\ndata: ${JSON.stringify(late)}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  );
  assertEquals(summary(await after.events()), ['response', 'done']);
});

Deno.test('an image turn yields its image; one that returns none fails, streamed and buffered', async () => {
  const image = { builtins: [], image: { type: 'image' as const, includeText: false } };
  const host: Host = { profileType: 'image', builtInTools: [] };
  const drawn = run(
    sse([
      row('step.delta', {
        index: 0,
        delta: { type: 'image', mime_type: 'image/jpeg', data: 'abc' },
      }),
      row('interaction.completed', { interaction: { status: 'completed' } }),
    ]),
    image,
    {},
    host,
  );
  assertEquals(await drawn.events(), [
    { type: 'media', media: { mimeType: 'image/jpeg', data: 'abc' } },
    { type: 'done', stop: { kind: 'completed', native: 'completed' } },
  ]);
  const wanted = 'error:no image returned from image generation';
  const streamed = run(
    sse([
      row('step.delta', { index: 0, delta: { type: 'text', text: 'no' } }),
      row('interaction.completed', { interaction: { id: 'v1_i', status: 'completed' } }),
    ]),
    image,
    {},
    host,
  );
  assertEquals(summary(await streamed.events()), ['text', 'response', wanted, 'done']);
  const buffered = run(
    Response.json({ id: 'v1_i', status: 'completed', steps: [] }),
    { ...image, stream: false },
    {},
    host,
  );
  assertEquals(summary(await buffered.events()), ['response', wanted, 'done']);
});

Deno.test('a speech turn gives its PCM as WAV; text alone is an error, and only for a voice', async () => {
  const pcm = new Uint8Array([1, 2, 3, 4]);
  const completed = row('interaction.completed', {
    interaction: { id: 'v1_tts', status: 'completed' },
  });
  const speech = { builtins: [], speech: { voice: 'Kore', format: 'pcm' as const } };
  const host: Host = { profileType: 'speech', builtInTools: [] };
  // gemini-3.1-flash-tts-preview streams `audio/l16` with the format beside it (23/09/2026).
  const spoken = run(
    sse([
      row('step.delta', {
        index: 0,
        delta: {
          type: 'audio',
          mime_type: 'audio/l16',
          sample_rate: 24000,
          channels: 1,
          data: bytesToBase64(pcm),
        },
      }),
      completed,
    ]),
    speech,
    {},
    host,
  );
  const out = await spoken.events();
  assertEquals(summary(out), ['media', 'response', 'done']);
  assertEquals(out[0], {
    type: 'media',
    media: {
      mimeType: 'audio/wav',
      data: bytesToBase64(wrapPcmAsWav(pcm, { sampleRate: 24000, channels: 1 })),
    },
  });
  const textOnly = sse([
    row('step.delta', { index: 0, delta: { type: 'text', text: 'hello' } }),
    completed,
  ]);
  const unspoken = await run(textOnly, speech, {}, host).events();
  assertEquals(summary(unspoken), [
    'text',
    'response',
    'error:speech audio was not returned by the model',
    'done',
  ]);
  assertEquals(
    unspoken.find((event) => event.type === 'error'),
    {
      type: 'error',
      errorKind: 'bad_response',
      errorInternal: 'speech audio was not returned by the model',
    },
  );
  const plain = await run(textOnly, { builtins: [] }, {}, { builtInTools: [] }).events();
  assertEquals(summary(plain), ['text', 'response', 'done']);
});

Deno.test('a streamed image that names no type is typed from its bytes; other bytes are no image', async () => {
  const image = { builtins: [], image: { type: 'image' as const, includeText: false } };
  const host: Host = { profileType: 'image', builtInTools: [] };
  const drawnFrom = (data: string) =>
    run(
      sse([
        row('step.delta', { index: 0, delta: { type: 'image', data } }),
        row('interaction.completed', { interaction: { status: 'completed' } }),
      ]),
      image,
      {},
      host,
    );
  assertEquals(await drawnFrom('/9j/abc').events(), [
    { type: 'media', media: { mimeType: 'image/jpeg', data: '/9j/abc' } },
    { type: 'done', stop: { kind: 'completed', native: 'completed' } },
  ]);
  assertEquals(summary(await drawnFrom('abc').events()), [
    'error:no image returned from image generation',
    'done',
  ]);
});

Deno.test('an image turn sends its prompt and reference image, and asks for the image it pins', async () => {
  const image = {
    type: 'image' as const,
    includeText: false,
    mimeType: 'image/jpeg',
    aspectRatio: '1:1',
    resolution: '1K',
  };
  const turn = {
    system: 'sys',
    builtins: [],
    input: [
      { type: 'text' as const, text: 'fox' },
      { type: 'image' as const, mimeType: 'image/jpeg', data: 'ex' },
    ],
    image,
  };
  const host: Host = {
    profileType: 'image',
    builtInTools: [],
    apiId: 'gemini-3.1-flash-lite-image',
  };
  const reply = () =>
    Promise.resolve(sse([row('interaction.completed', { interaction: { status: 'completed' } })]));
  const imageOnly = run(reply, turn, {}, host);
  await imageOnly.events();
  const body = imageOnly.sent[0]?.body as JsonObject;
  assertEquals(body.model, 'gemini-3.1-flash-lite-image');
  assertEquals(body.system_instruction, 'sys');
  assertEquals((body.input as JsonObject[])[0], {
    type: 'user_input',
    content: [
      { type: 'text', text: 'fox' },
      { type: 'image', data: 'ex', mime_type: 'image/jpeg' },
    ],
  });
  const entry = { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '1:1', image_size: '1K' };
  assertEquals(body.response_format, entry);
  assertEquals(Object.hasOwn(body, 'response_modalities'), false);
  const withText = run(reply, { ...turn, image: { ...image, includeText: true } }, {}, host);
  await withText.events();
  assertEquals(withText.sent[0]?.body.response_format, [{ type: 'text' }, entry]);
});
