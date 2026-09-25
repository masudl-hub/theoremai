import '../../../fixtures/test-host.ts';
import { assertEquals } from '../../../../src/kernel/engine/assert.ts';
import { resolveTurn } from '../../../../src/kernel/registry/resolve.ts';
import type { KeyVault, ProviderCompleteRequest, TurnEvent } from '../../../../src/kernel/types.ts';
import { base64ToBytes, bytesToBase64 } from '../../../../src/kernel/util/base64.ts';
import {
  camelToSnake,
  toInteractionsBody,
} from '../../../../src/providers/google/interactions/framing.ts';
import {
  createInteractionsProvider,
  eventsFromStep,
  foldBody,
  foldPayload,
  newStreamFold,
  openStepEvents,
} from '../../../../src/providers/google/interactions/stream.ts';
import { INTERACTIONS_JSON_URL, INTERACTIONS_URL } from '../../../../src/providers/google/urls.ts';
import { wrapPcmAsWav } from '../../../../src/providers/shared/pcm.ts';

const vault: KeyVault = {
  slotA: 'free-a-key',
  slotB: 'free-b-key',
  slotC: 'free-c-key',
  paid: 'paid-key',
};

const HTTP_OK = 200;
const HTTP_SERVER = 500;
const HTTP_QUOTA = 429;

function noWait(): Promise<void> {
  return Promise.resolve();
}

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

function sseResponse(events: unknown[], status = HTTP_OK): Response {
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\n`).join('\n');
  return new Response(`${payload}\ndata: [DONE]\n`, { status });
}

function headerApiKey(init?: RequestInit): string {
  return new Headers(init?.headers).get('x-goog-api-key') ?? '';
}

function fromChatProfile(): ProviderCompleteRequest {
  const { generation } = resolveTurn({
    profile: 'chat',
    input: { text: 'hi' },
  });
  return {
    model: generation.model,
    apiId: generation.apiId,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system: 'sys',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    keySlot: generation.keySlot,
  };
}

Deno.test('host profile Interactions body streams JSON schema and never ships keySlot', () => {
  const req = fromChatProfile();
  const body = toInteractionsBody(req);
  const format = body[camelToSnake('responseFormat')] as unknown[];
  const config = body[camelToSnake('generationConfig')] as Record<string, unknown>;
  assertEquals(body.stream, true);
  assertEquals(Object.hasOwn(body, 'store'), false);
  assertEquals(body.model, 'gemini-3.5-flash-lite');
  assertEquals(config[camelToSnake('maxOutputTokens')], req.maxOutputTokens);
  assertEquals(Array.isArray(format), true);
  assertEquals(Object.hasOwn(body, camelToSnake('keySlot')), false);
  assertEquals(Object.hasOwn(body, 'keySlot'), false);
  assertEquals(Object.hasOwn(body, camelToSnake('previousInteractionId')), false);
});

Deno.test('Interactions body passes explicit store and previous interaction id', () => {
  const req = fromChatProfile();
  req.store = false;
  req.previousInteractionId = 'v1_prev';
  const body = toInteractionsBody(req);
  assertEquals(body.store, false);
  assertEquals(body[camelToSnake('previousInteractionId')], 'v1_prev');
});

Deno.test('chat voice audio wires as Interactions type audio', () => {
  const { generation } = resolveTurn({
    profile: 'chat',
    input: {
      text: 'hi',
      voice: [{ mimeType: 'audio/webm;codecs=opus', data: 'dGVzdA==' }],
    },
  });
  const body = toInteractionsBody({
    model: generation.model,
    apiId: generation.apiId,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system: 'sys',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    keySlot: generation.keySlot,
  });
  const input = body.input as Array<{ content: Array<Record<string, unknown>> }>;
  const parts = input[0]?.content ?? [];
  assertEquals(
    parts.some((part) => part.type === 'audio' && part[camelToSnake('mimeType')] === 'audio/webm'),
    true,
  );
});

Deno.test('Interactions body formats multi-turn history with text and parts', () => {
  const req = fromChatProfile();
  req.history = [
    { role: 'user', content: 'What is record care?' },
    { role: 'assistant', content: 'It is maintaining records.' },
    {
      role: 'user',
      parts: [
        { type: 'text', text: 'Check this image' },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
      ],
    },
  ];
  const body = toInteractionsBody(req);
  const input = body.input as Array<{ type: string; content: Array<Record<string, string>> }>;
  assertEquals(input.length, 4);
  assertEquals(input[0]?.type, 'user_input');
  assertEquals(input[0]?.content[0]?.text, 'What is record care?');
  assertEquals(input[1]?.type, 'model_output');
  assertEquals(input[1]?.content[0]?.text, 'It is maintaining records.');
  assertEquals(input[2]?.type, 'user_input');
  assertEquals(input[2]?.content[0]?.text, 'Check this image');
  assertEquals(input[2]?.content[1]?.mime_type, 'image/png');
  assertEquals(input[3]?.type, 'user_input');
  assertEquals(input[3]?.content[0]?.text, '<user_data>\nhi\n</user_data>');
});

Deno.test('JSON Schema property names stay camelCase inside response_format.schema', () => {
  const { generation } = resolveTurn({
    profile: 'formatter',
    input: { text: 'x', slots: { language: 'html' } },
  });
  const body = toInteractionsBody({
    model: generation.model,
    apiId: generation.apiId,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system: '',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    keySlot: generation.keySlot,
  });
  const format = body[camelToSnake('responseFormat')] as Array<Record<string, unknown>>;
  const schema = format[0]?.schema as Record<string, unknown>;
  assertEquals(Object.hasOwn(schema.properties as Record<string, unknown>, 'message'), true);
  assertEquals(Object.hasOwn(schema.properties as Record<string, unknown>, 'html'), true);
});

Deno.test('a profile without structured output sends no response_format', () => {
  const { generation } = resolveTurn({
    profile: 'selector',
    model: 'gemini35FlashLite',
    input: { text: 'x' },
  });
  const body = toInteractionsBody({
    model: generation.model,
    apiId: generation.apiId,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system: '',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    keySlot: generation.keySlot,
  });
  assertEquals(body[camelToSnake('responseFormat')], undefined);
});

Deno.test('pinned profile wires 3.5 minimal through theorem', () => {
  const { generation } = resolveTurn({
    profile: 'pinned',
    input: { text: 'x' },
  });
  assertEquals(generation.model, 'gemini35FlashLite');
  assertEquals(generation.thinking, 'low');
  const body = toInteractionsBody({
    model: generation.model,
    apiId: generation.apiId,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system: '',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    keySlot: generation.keySlot,
  });
  const config = body[camelToSnake('generationConfig')] as Record<string, unknown>;
  assertEquals(body.model, 'gemini-3.5-flash-lite');
  assertEquals(config[camelToSnake('thinkingLevel')], 'low');
});

// Interactions rows below follow the shapes recorded from gemini-3.8-flash and
// gemini-3.1-pro-preview (23/09/2026); ids, text and bytes are synthetic.

function row(eventType: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { event_type: eventType, ...fields };
}

function completedRow(status = 'completed'): Record<string, unknown> {
  return row('interaction.completed', { interaction: { id: 'v1_int', status } });
}

function foldRows(rows: Record<string, unknown>[]): TurnEvent[] {
  const fold = newStreamFold();
  return rows.flatMap((r) => foldPayload(r, fold));
}

function imageRequest(): ProviderCompleteRequest {
  const { generation } = resolveTurn({ profile: 'image', input: { text: 'fox' } });
  return {
    model: generation.model,
    apiId: generation.apiId,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system: '',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    keySlot: generation.keySlot,
  };
}

function pcmBase64(bytes: number[]): string {
  return bytesToBase64(new Uint8Array(bytes));
}

function wavBase64(bytes: number[], sampleRate: number): string {
  return bytesToBase64(wrapPcmAsWav(new Uint8Array(bytes), { sampleRate, channels: 1 }));
}

Deno.test('provider POSTs Interactions JSON when stream is false', async () => {
  let href = '';
  let postedStream: unknown;
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: (url, init) => {
      href = String(url);
      postedStream = JSON.parse(String(init?.body ?? '{}')).stream;
      return Promise.resolve(
        Response.json({
          id: 'v1_batch',
          status: 'completed',
          steps: [
            { type: 'thought', signature: 'sig' },
            {
              type: 'code_execution_call',
              id: 'code_call_1',
              arguments: { language: 'PYTHON', code: 'print(1)' },
            },
            {
              type: 'code_execution_result',
              call_id: 'code_call_1',
              is_error: false,
              result: '1\n',
            },
            { type: 'model_output', content: [{ type: 'text', text: 'One.' }] },
          ],
        }),
      );
    },
  });
  const events = await collect(
    provider.complete({ ...fromChatProfile(), structured: null, stream: false }),
  );
  assertEquals(href, INTERACTIONS_JSON_URL);
  assertEquals(postedStream, false);
  assertEquals(
    events.map((e) => (e.type === 'evidence' ? `${e.evidence?.kind}` : e.type)),
    ['response', 'code_execution_call', 'code_execution_result', 'text', 'done'],
  );
  assertEquals(events[1]?.evidence?.code, 'print(1)');
  assertEquals(events[2]?.evidence?.result, '1\n');
});

Deno.test('buffered body emits its function_call step as a tool call', async () => {
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () =>
      Promise.resolve(
        Response.json({
          id: 'v1_tool',
          status: 'requires_action',
          steps: [
            { type: 'thought', signature: 'sig' },
            {
              type: 'function_call',
              id: 'call_1',
              name: 'get_soil_moisture',
              arguments: { plant: 'plant A' },
            },
          ],
        }),
      ),
  });
  const events = await collect(provider.complete({ ...fromChatProfile(), stream: false }));
  assertEquals(events, [
    { type: 'response', response: { id: 'v1_tool' } },
    {
      type: 'tool',
      tool: { id: 'call_1', name: 'get_soil_moisture', arguments: { plant: 'plant A' } },
    },
    {
      type: 'done',
      stop: { kind: 'tool', native: 'requires_action' },
      interactionId: 'v1_tool',
    },
  ]);
});

Deno.test('buffered body emits its thought summary', () => {
  const events = foldBody(
    {
      id: 'v1_thought',
      status: 'completed',
      steps: [
        { type: 'thought', signature: 'sig', summary: [{ type: 'text', text: 'Weighing it.' }] },
        { type: 'model_output', content: [{ type: 'text', text: 'Done.' }] },
      ],
    },
    newStreamFold(),
  );
  assertEquals(events.slice(0, 3), [
    { type: 'response', response: { id: 'v1_thought' } },
    { type: 'thought', text: 'Weighing it.' },
    { type: 'text', text: 'Done.' },
  ]);
});

Deno.test('buffered speech body emits its audio once, as WAV at the stated rate', () => {
  const fold = newStreamFold();
  const events = foldBody(
    {
      id: 'v1_speech',
      status: 'completed',
      steps: [
        {
          type: 'model_output',
          content: [
            {
              type: 'audio',
              mime_type: 'audio/l16; rate=24000; channels=1',
              sample_rate: 24000,
              channels: 1,
              data: pcmBase64([1, 0, 2, 0]),
            },
          ],
        },
      ],
    },
    fold,
  );
  assertEquals(
    events.filter((e) => e.type === 'media'),
    [{ type: 'media', media: { mimeType: 'audio/wav', data: wavBase64([1, 0, 2, 0], 24000) } }],
  );
  assertEquals(fold.sawMedia, true);
});

Deno.test('provider POSTs Interactions SSE on the resolved key slot', async () => {
  const used: string[] = [];
  let href = '';
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: (url, init) => {
      href = String(url);
      used.push(headerApiKey(init));
      return Promise.resolve(
        sseResponse([
          row('step.start', { index: 0, step: { type: 'thought' } }),
          row('step.delta', {
            index: 0,
            delta: { type: 'thought_summary', content: { type: 'text', text: 'hmm' } },
          }),
          row('step.stop', { index: 0 }),
          row('step.start', { index: 1, step: { type: 'model_output' } }),
          row('step.delta', { index: 1, delta: { type: 'text', text: '{"message":"ok"}' } }),
          row('step.stop', { index: 1 }),
          completedRow(),
        ]),
      );
    },
  });
  const events = await collect(provider.complete(fromChatProfile()));
  assertEquals(href, INTERACTIONS_URL);
  assertEquals(used, ['free-a-key']);
  assertEquals(events, [
    { type: 'thought', text: 'hmm' },
    { type: 'text', text: '{"message":"ok"}' },
    { type: 'response', response: { id: 'v1_int' } },
    {
      type: 'done',
      stop: { kind: 'completed', native: 'completed' },
      interactionId: 'v1_int',
    },
    { type: 'structured', structured: { message: 'ok' } },
  ]);
});

Deno.test('provider emits grounding once from a buffered search body', async () => {
  // Shape recorded from gemini-3.8-flash with google_search, stream: false (23/09/2026).
  const chipHtml = '<div class="chip">care</div>';
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () =>
      Promise.resolve(
        Response.json({
          id: 'v1_grounded',
          status: 'completed',
          steps: [
            { type: 'google_search_call', id: 'call_1', arguments: { queries: ['care'] } },
            {
              type: 'google_search_result',
              call_id: 'call_1',
              search_type: 'web_search',
              result: [{ search_suggestions: chipHtml }],
            },
            {
              type: 'model_output',
              content: [
                {
                  type: 'text',
                  text: 'Water weekly.',
                  annotations: [
                    {
                      start_index: 0,
                      end_index: 13,
                      url: 'https://grounding.example/redirect/care',
                      title: 'example.com',
                      type: 'url_citation',
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
  });
  const events = await collect(provider.complete({ ...fromChatProfile(), stream: false }));
  const grounding = events.filter((event) => event.type === 'grounding');
  assertEquals(grounding.length, 1);
  assertEquals(grounding[0]?.grounding?.searchHtml, chipHtml);
  assertEquals(grounding[0]?.grounding?.sources, [
    { type: 'web', uri: 'https://grounding.example/redirect/care', title: 'example.com' },
  ]);
});

Deno.test('provider overflows to paid only after 429 backoff', async () => {
  const used: string[] = [];
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: (_url, init) => {
      const key = headerApiKey(init);
      used.push(key);
      if (key !== 'paid-key') {
        return Promise.resolve(new Response('no', { status: HTTP_QUOTA }));
      }
      return Promise.resolve(
        sseResponse([row('step.delta', { index: 0, delta: { type: 'text', text: 'hi' } })]),
      );
    },
  });
  const events = await collect(provider.complete(fromChatProfile()));
  assertEquals(used, ['free-a-key', 'free-a-key', 'free-a-key', 'paid-key']);
  assertEquals(events[0], { type: 'text', text: 'hi' });
});

Deno.test('non-OK Gemini response becomes an error event', async () => {
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () => Promise.resolve(new Response('nope', { status: HTTP_SERVER })),
  });
  const events = await collect(provider.complete(fromChatProfile()));
  assertEquals(events, [
    {
      type: 'error',
      errorKind: 'unavailable',
      errorInternal: 'Gemini HTTP 500: nope',
    },
  ]);
});

Deno.test('thrown fetch errors become network errors', async () => {
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () => Promise.reject(new TypeError('fetch failed: dns')),
  });
  const events = await collect(provider.complete(fromChatProfile()));
  assertEquals(events, [
    {
      type: 'error',
      errorKind: 'network',
      errorInternal: 'fetch failed: dns',
    },
  ]);
});

Deno.test('image delta yields media', async () => {
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () =>
      Promise.resolve(
        sseResponse([
          row('step.delta', {
            index: 0,
            delta: { type: 'image', mime_type: 'image/jpeg', data: 'abc' },
          }),
          row('interaction.completed', { interaction: { status: 'completed' } }),
        ]),
      ),
  });
  const events = await collect(provider.complete(imageRequest()));
  assertEquals(events, [
    { type: 'media', media: { mimeType: 'image/jpeg', data: 'abc' } },
    { type: 'done', stop: { kind: 'completed', native: 'completed' } },
  ]);
});

Deno.test('streamed audio deltas become WAV at the sample rate each delta reports', () => {
  const events = foldRows([
    row('step.start', { index: 0, step: { type: 'model_output' } }),
    row('step.delta', {
      index: 0,
      delta: {
        type: 'audio',
        mime_type: 'audio/l16',
        sample_rate: 24000,
        channels: 1,
        data: pcmBase64([1, 0]),
      },
    }),
    row('step.stop', { index: 0 }),
  ]);
  assertEquals(events, [
    { type: 'media', media: { mimeType: 'audio/wav', data: wavBase64([1, 0], 24000) } },
  ]);
});

Deno.test('provider handles null body, completed usage, and structured resolution', async () => {
  const nullBodyProvider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () => Promise.resolve(new Response(null, { status: 200 })),
  });
  const nullEvents = await collect(nullBodyProvider.complete(imageRequest()));
  assertEquals(nullEvents.length, 1);
  assertEquals(nullEvents[0]?.type, 'error');

  const structProvider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () =>
      Promise.resolve(
        sseResponse([
          row('step.delta', {
            index: 0,
            delta: { type: 'text', text: '{"message": "success"}' },
          }),
          row('interaction.completed', {
            interaction: {
              id: 'v1_s',
              status: 'completed',
              usage: { total_input_tokens: 10, total_output_tokens: 20 },
            },
          }),
        ]),
      ),
  });
  const resultEvents = await collect(structProvider.complete(fromChatProfile()));
  assertEquals(resultEvents.find((e) => e.type === 'tokens')?.tokens, {
    input: 10,
    output: 20,
    total: 30,
  });
  assertEquals(resultEvents.find((e) => e.type === 'structured')?.structured, {
    message: 'success',
  });
});

Deno.test('base64ToBytes decodes known base64 values', () => {
  assertEquals(base64ToBytes('aGVsbG8='), new TextEncoder().encode('hello'));
  assertEquals(base64ToBytes(''), new Uint8Array());
});

Deno.test('bytesToBase64 encodes known byte values', () => {
  assertEquals(bytesToBase64(new TextEncoder().encode('hello')), 'aGVsbG8=');
  assertEquals(bytesToBase64(new Uint8Array()), '');
});

Deno.test('base64 helpers roundtrip arbitrary bytes', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const encoded = bytesToBase64(bytes);
  assertEquals(base64ToBytes(encoded), bytes);
});

Deno.test('streamed code execution emits each step once, whole, at step.stop', () => {
  const events = foldRows([
    row('step.start', {
      index: 1,
      step: { id: 'code_1', signature: '', type: 'code_execution_call' },
    }),
    row('step.delta', {
      index: 1,
      delta: {
        type: 'code_execution_call',
        arguments: { language: 'PYTHON', code: 'print(sum(range(1, 11)))' },
      },
    }),
    row('step.stop', { index: 1 }),
    row('step.start', {
      index: 2,
      step: { call_id: 'code_1', signature: '', type: 'code_execution_result' },
    }),
    row('step.delta', {
      index: 2,
      delta: { type: 'code_execution_result', is_error: false, result: '55\n' },
    }),
    row('step.stop', { index: 2 }),
  ]);
  assertEquals(events.length, 2);
  assertEquals(events[0]?.evidence?.kind, 'code_execution_call');
  assertEquals(events[0]?.evidence?.id, 'code_1');
  assertEquals(events[0]?.evidence?.code, 'print(sum(range(1, 11)))');
  assertEquals(events[0]?.evidence?.language, 'PYTHON');
  assertEquals(events[1]?.evidence?.kind, 'code_execution_result');
  assertEquals(events[1]?.evidence?.callId, 'code_1');
  assertEquals(events[1]?.evidence?.result, '55\n');
  assertEquals(events[1]?.evidence?.isError, false);
});

Deno.test('streamed builtin steps emit once with start and delta fields merged', () => {
  const events = foldRows([
    row('step.start', {
      index: 0,
      step: { id: 'call_s', signature: '', type: 'google_search_call' },
    }),
    row('step.delta', {
      index: 0,
      delta: { type: 'google_search_call', arguments: { queries: ['care'] }, signature: 'sig_a' },
    }),
    row('step.stop', { index: 0 }),
  ]);
  assertEquals(events, [
    {
      type: 'evidence',
      evidence: {
        provider: 'google',
        raw: {
          id: 'call_s',
          signature: 'sig_a',
          type: 'google_search_call',
          arguments: { queries: ['care'] },
        },
        kind: 'google_search_call',
      },
    },
  ]);
});

Deno.test('streamed google_search_result emits grounding on its delta and evidence at stop', () => {
  const chipHtml = '<div class="chip">photosynthesis</div>';
  const events = foldRows([
    row('step.start', {
      index: 1,
      step: { call_id: 'call_s', signature: '', type: 'google_search_result' },
    }),
    row('step.delta', {
      index: 1,
      delta: {
        type: 'google_search_result',
        is_error: false,
        result: [{ search_suggestions: chipHtml }],
        signature: 'sig_b',
      },
    }),
    row('step.stop', { index: 1 }),
  ]);
  assertEquals(
    events.map((e) => e.type),
    ['grounding', 'evidence'],
  );
  assertEquals(events[0]?.grounding?.searchHtml, chipHtml);
  assertEquals(events[1]?.evidence?.raw?.call_id, 'call_s');
  assertEquals(events[1]?.evidence?.raw?.result, [{ search_suggestions: chipHtml }]);
});

Deno.test('foldPayload emits grounding chunks from google_maps_result places', () => {
  const events = foldPayload(
    row('step.delta', {
      index: 1,
      delta: {
        type: 'google_maps_result',
        result: [
          {
            places: [
              {
                place_id: 'ChIJ_primary',
                name: 'Swansons Nursery - Google Maps',
                url: 'https://maps.google.com/maps?cid=1',
              },
              {
                place_id: 'ChIJ_primary',
                name: 'Review of Swansons Nursery - Google Maps',
                url: 'https://www.google.com/maps/reviews/data=!1',
              },
              {
                place_id: 'ChIJ_other',
                name: 'Sky Nursery - Google Maps',
                url: 'https://maps.google.com/maps?cid=2',
              },
            ],
          },
        ],
        signature: 'sig',
      },
    }),
    newStreamFold(),
  );
  const grounding = events.find((e) => e.type === 'grounding')?.grounding;
  assertEquals(grounding?.chunks?.length, 2);
  assertEquals(grounding?.sources?.length, 2);
  const firstChunk = grounding?.chunks?.[0] as
    | { maps?: { title?: string; placeId?: string } }
    | undefined;
  assertEquals(firstChunk?.maps?.title, 'Swansons Nursery - Google Maps');
  assertEquals(firstChunk?.maps?.placeId, 'ChIJ_primary');
  assertEquals(grounding?.sources?.[0]?.placeId, 'ChIJ_primary');
});

Deno.test('foldPayload emits grounding from a text_annotation_delta place_citation', () => {
  const events = foldPayload(
    row('step.delta', {
      index: 2,
      delta: {
        type: 'text_annotation_delta',
        annotations: [
          {
            type: 'place_citation',
            place_id: 'ChIJ_cite',
            name: 'Swansons Nursery - Google Maps',
            url: 'https://maps.google.com/maps?cid=9',
          },
        ],
      },
    }),
    newStreamFold(),
  );
  const grounding = events.find((e) => e.type === 'grounding')?.grounding;
  assertEquals(grounding?.sources?.length, 1);
  assertEquals(grounding?.chunks?.length, 1);
  assertEquals(grounding?.sources?.[0]?.placeId, 'ChIJ_cite');
  assertEquals(grounding?.sources?.[0]?.title, 'Swansons Nursery - Google Maps');
});

Deno.test('streamed function_call waits for step.stop and parses the streamed arguments', () => {
  const fold = newStreamFold();
  const before = [
    row('step.start', {
      index: 1,
      step: { id: 'call_1', type: 'function_call', name: 'get_soil_moisture', arguments: {} },
    }),
    row('step.delta', { index: 1, delta: { arguments: '{"plant":', type: 'arguments_delta' } }),
    row('step.delta', { index: 1, delta: { arguments: '"plant A"}', type: 'arguments_delta' } }),
  ].flatMap((r) => foldPayload(r, fold));
  assertEquals(before, []);
  assertEquals(foldPayload(row('step.stop', { index: 1 }), fold), [
    {
      type: 'tool',
      tool: { id: 'call_1', name: 'get_soil_moisture', arguments: { plant: 'plant A' } },
    },
  ]);
  assertEquals(fold.steps.size, 0);
});

Deno.test('streamed function_call with no arguments_delta keeps its start arguments', () => {
  const events = foldRows([
    row('step.start', {
      index: 0,
      step: { id: 'call_2', type: 'function_call', name: 'list_plants', arguments: {} },
    }),
    row('step.stop', { index: 0 }),
  ]);
  assertEquals(events, [
    { type: 'tool', tool: { id: 'call_2', name: 'list_plants', arguments: {} } },
  ]);
});

Deno.test('streamed function_call with unparseable arguments becomes a tool failure', () => {
  const events = foldRows([
    row('step.start', {
      index: 0,
      step: { id: 'call_3', type: 'function_call', name: 'water', arguments: {} },
    }),
    row('step.delta', { index: 0, delta: { arguments: '{"ml":', type: 'arguments_delta' } }),
    row('step.stop', { index: 0 }),
  ]);
  assertEquals(events.length, 1);
  assertEquals(events[0]?.tool?.phase, 'error');
  assertEquals(events[0]?.tool?.failure?.code, 'malformed_arguments');
  assertEquals(events[0]?.tool?.failure?.kind, 'bad_response');
});

Deno.test('a step still open when the stream ends waits, then comes out as partial evidence', () => {
  const fold = newStreamFold();
  const events = [
    row('step.start', {
      index: 0,
      step: { id: 'code_9', signature: '', type: 'code_execution_call' },
    }),
    row('step.delta', {
      index: 0,
      delta: { type: 'code_execution_call', arguments: { language: 'PYTHON', code: 'x = 1' } },
    }),
  ].flatMap((r) => foldPayload(r, fold));
  assertEquals(events, []);
  assertEquals(openStepEvents(fold), [
    {
      type: 'evidence',
      evidence: {
        provider: 'google',
        raw: {
          id: 'code_9',
          signature: '',
          type: 'code_execution_call',
          arguments: { language: 'PYTHON', code: 'x = 1' },
        },
        kind: 'code_execution_call',
        code: 'x = 1',
        language: 'PYTHON',
        id: 'code_9',
        partial: true,
      },
    },
  ]);
  assertEquals(fold.steps.size, 0);
});

Deno.test('a partial function_call is evidence and never a tool call', () => {
  const fold = newStreamFold();
  foldPayload(
    row('step.start', {
      index: 2,
      step: { id: 'call_7', name: 'get_soil_moisture', arguments: {}, type: 'function_call' },
    }),
    fold,
  );
  foldPayload(
    row('step.delta', { index: 2, delta: { type: 'arguments_delta', arguments: '{"plant":"pla' } }),
    fold,
  );
  assertEquals(openStepEvents(fold), [
    {
      type: 'evidence',
      evidence: {
        provider: 'google',
        raw: {
          id: 'call_7',
          name: 'get_soil_moisture',
          arguments: '{"plant":"pla',
          type: 'function_call',
        },
        kind: 'function_call',
        partial: true,
      },
    },
  ]);
});

Deno.test('a stream cut off before the interaction reports a status stops as stream_incomplete', async () => {
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () =>
      Promise.resolve(
        sseResponse([
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
      ),
  });
  const events = await collect(provider.complete({ ...fromChatProfile(), structured: null }));
  assertEquals(
    events.map((ev) => ev.type),
    ['response', 'text', 'evidence', 'done'],
  );
  // `interaction.created` named the response before any output, so the cut stream still does.
  assertEquals(events[0]?.response, { id: 'v1_cut', model: 'gemini-test-flash' });
  assertEquals(events[2]?.evidence?.partial, true);
  assertEquals(events[2]?.evidence?.kind, 'function_call');
  assertEquals(events[3]?.stop, { kind: 'stream_incomplete' });
});

Deno.test('a stream row that is not a JSON object is an error', async () => {
  const encoder = new TextEncoder();
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: not json\n\n'));
              controller.close();
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
  });
  const events = await collect(provider.complete({ ...fromChatProfile(), structured: null }));
  assertEquals(
    events.map((ev) => ev.type),
    ['error'],
  );
  assertEquals(
    events[0]?.errorInternal?.includes('Interactions stream row was not a JSON object'),
    true,
  );
});

Deno.test('lifecycle rows emit only the identity interaction.created names; stray usage emits nothing', () => {
  assertEquals(
    foldRows([
      row('interaction.created', { interaction: { id: 'v1_int', status: 'in_progress' } }),
      row('interaction.status_update', { interaction_id: 'v1_int', status: 'in_progress' }),
      row('step.delta', {
        index: 0,
        delta: { type: 'thought_signature', signature: 'sig' },
        usage: { total_input_tokens: 3, total_output_tokens: 7 },
      }),
    ]),
    [{ type: 'response', response: { id: 'v1_int' } }],
  );
});

Deno.test('eventsFromStep ignores step types it does not know', () => {
  assertEquals(eventsFromStep({ type: 'user_input', content: [{ type: 'text', text: 'hi' }] }), []);
  assertEquals(eventsFromStep({}), []);
});

const COMBINED_ERROR = "'google_maps' and 'google_search' cannot be combined in the same request.";

Deno.test('foldPayload turns an SSE error event into an error event', () => {
  const events = foldPayload(
    row('error', {
      error: { code: 'invalid_request', message: COMBINED_ERROR },
      event_id: 'evt_1',
    }),
    newStreamFold(),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
  assertEquals(events[0]?.errorInternal, COMBINED_ERROR);
});

Deno.test('provider emits error event when SSE stream returns an API error payload', async () => {
  const transport = {
    vault,
    wait: noWait,
    fetch: () => {
      const errorRow = JSON.stringify({
        event_type: 'error',
        error: { code: 'invalid_request', message: COMBINED_ERROR },
      });
      return Promise.resolve(
        new Response(`event: error\ndata: ${errorRow}\n\n`, { status: HTTP_OK }),
      );
    },
  };
  const provider = createInteractionsProvider(transport);
  const events = await collect(provider.complete(fromChatProfile()));
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
  assertEquals(events[0]?.errorInternal, COMBINED_ERROR);
});
