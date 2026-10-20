import '../../../fixtures/test-host.ts';
import { assertEquals } from '@std/assert';
import { resolveTurn } from '../../../../src/kernel/default-scope.ts';
import { providerBuiltins } from '../../../../src/kernel/registry/provider-request.ts';
import { defaultKernelScope } from '../../../../src/kernel/scope.ts';
import type { DistributiveOmit } from '../../../../src/kernel/tools/events.ts';
import type { ProviderEvidence } from '../../../../src/kernel/turn-events.ts';
import type { ModelEvent, ModelRequest } from '../../../../src/kernel/types.ts';
import { base64ToBytes, bytesToBase64 } from '../../../../src/kernel/util/base64.ts';
import {
  camelToSnake,
  type InteractionsRequest,
  toInteractionsBody,
} from '../../../../src/providers/google/interactions/framing.ts';
import {
  eventsFromStep,
  finalizeStructured,
  foldBody,
  foldPayload,
  newStreamFold,
  openStepEvents,
} from '../../../../src/providers/google/interactions/stream.ts';
import { wrapPcmAsWav } from '../../../../src/providers/shared/pcm.ts';
import {
  citedUris,
  eventAt,
  eventsOf,
  firstOf,
  rawCallsOf,
  toolEventsOf,
} from '../../../fixtures/events.ts';

function fromChatProfile(): ModelRequest {
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
    builtins: providerBuiltins(defaultKernelScope.tools, generation.builtins),
    system: 'sys',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
  };
}

Deno.test('host profile Interactions body streams JSON schema and sends no store or previous id', () => {
  const req = fromChatProfile();
  const body = toInteractionsBody(req);
  const format = body[camelToSnake('responseFormat')] as unknown[];
  const config = body[camelToSnake('generationConfig')] as Record<string, unknown>;
  assertEquals(body.stream, true);
  assertEquals(Object.hasOwn(body, 'store'), false);
  assertEquals(body.model, 'gemini-3.5-flash-lite');
  assertEquals(config[camelToSnake('maxOutputTokens')], req.maxOutputTokens);
  assertEquals(Array.isArray(format), true);
  assertEquals(Object.hasOwn(body, camelToSnake('previousInteractionId')), false);
});

Deno.test('Interactions body passes explicit store and previous interaction id', () => {
  const req: InteractionsRequest = {
    ...fromChatProfile(),
    store: false,
    previousInteractionId: 'v1_prev',
  };
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
    builtins: providerBuiltins(defaultKernelScope.tools, generation.builtins),
    system: 'sys',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
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
    builtins: providerBuiltins(defaultKernelScope.tools, generation.builtins),
    system: '',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
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
    builtins: providerBuiltins(defaultKernelScope.tools, generation.builtins),
    system: '',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
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
    builtins: providerBuiltins(defaultKernelScope.tools, generation.builtins),
    system: '',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
  });
  const config = body[camelToSnake('generationConfig')] as Record<string, unknown>;
  assertEquals(body.model, 'gemini-3.5-flash-lite');
  assertEquals(config[camelToSnake('thinkingLevel')], 'low');
});

// Interactions rows below follow the shapes recorded from gemini-3.8-flash and
// gemini-3.1-pro-preview (23/09/2026); ids, text, and bytes are synthetic.

function row(eventType: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { event_type: eventType, ...fields };
}

/** The typed evidence in `events`, without the provider's raw payload. */
function typedEvidence(events: readonly ModelEvent[]): DistributiveOmit<ProviderEvidence, 'raw'>[] {
  return eventsOf(events, 'evidence').map(({ evidence: { raw: _raw, ...typed } }) => typed);
}

function foldRows(rows: Record<string, unknown>[]): ModelEvent[] {
  const fold = newStreamFold();
  return rows.flatMap((r) => foldPayload(r, fold));
}

function pcmBase64(bytes: number[]): string {
  return bytesToBase64(new Uint8Array(bytes));
}

function wavBase64(bytes: number[], sampleRate: number): string {
  return bytesToBase64(wrapPcmAsWav(new Uint8Array(bytes), { sampleRate, channels: 1 }));
}

Deno.test('a buffered body emits its code execution steps as evidence, once each', () => {
  const events = foldBody(
    {
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
    },
    newStreamFold(),
  );
  assertEquals(
    events.map((e) => (e.type === 'evidence' ? `${e.evidence?.kind}` : e.type)),
    ['response', 'code_execution_call', 'code_execution_result', 'text', 'done'],
  );
  assertEquals(typedEvidence(events), [
    {
      provider: 'google',
      kind: 'code_execution_call',
      code: 'print(1)',
      language: 'PYTHON',
      id: 'code_call_1',
    },
    {
      provider: 'google',
      kind: 'code_execution_result',
      result: '1\n',
      isError: false,
      callId: 'code_call_1',
    },
  ]);
});

Deno.test('buffered body emits its function_call steps as tool calls, the thought signature as reasoning for the first', () => {
  const events = foldBody(
    {
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
        {
          type: 'function_call',
          id: 'call_2',
          name: 'get_soil_moisture',
          arguments: { plant: 'plant B' },
        },
      ],
    },
    newStreamFold(),
  );
  assertEquals(events, [
    { type: 'response', response: { id: 'v1_tool' } },
    {
      type: 'reasoning',
      data: { call: 0, signature: 'sig' },
      origin: { protocol: 'geminiInteractions' },
    },
    {
      type: 'tool',
      tool: { callId: 'call_1', name: 'get_soil_moisture', arguments: { plant: 'plant A' } },
    },
    {
      type: 'tool',
      tool: { callId: 'call_2', name: 'get_soil_moisture', arguments: { plant: 'plant B' } },
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
  assertEquals(eventsOf(events, 'media'), [
    { type: 'media', media: { mimeType: 'audio/wav', data: wavBase64([1, 0, 2, 0], 24000) } },
  ]);
  assertEquals(fold.sawMedia, true);
});

Deno.test('a buffered search body emits its grounding once', () => {
  // Shape recorded from gemini-3.8-flash with google_search, stream: false (23/09/2026).
  const chipHtml = '<div class="chip">care</div>';
  const events = foldBody(
    {
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
    },
    newStreamFold(),
  );
  const grounding = eventsOf(events, 'grounding');
  assertEquals(grounding.length, 1);
  assertEquals(grounding[0]?.grounding.searchHtml, chipHtml);
  assertEquals(citedUris(events), ['https://grounding.example/redirect/care']);
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

Deno.test('completed usage becomes tokens, and structured output resolves from the text', () => {
  const fold = newStreamFold();
  const events = [
    row('step.delta', { index: 0, delta: { type: 'text', text: '{"message": "success"}' } }),
    row('interaction.completed', {
      interaction: {
        id: 'v1_s',
        status: 'completed',
        usage: { total_input_tokens: 10, total_output_tokens: 20 },
      },
    }),
  ].flatMap((r) => foldPayload(r, fold));
  assertEquals(firstOf(events, 'tokens')?.tokens, { input: 10, output: 20, total: 30 });
  assertEquals(
    [...finalizeStructured(fromChatProfile(), fold)],
    [{ type: 'structured', structured: { message: 'success' } }],
  );
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
  assertEquals(typedEvidence(events), [
    {
      provider: 'google',
      kind: 'code_execution_call',
      code: 'print(sum(range(1, 11)))',
      language: 'PYTHON',
      id: 'code_1',
    },
    {
      provider: 'google',
      kind: 'code_execution_result',
      result: '55\n',
      isError: false,
      callId: 'code_1',
    },
  ]);
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
        kind: 'provider_step',
        step: 'google_search_call',
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
  assertEquals(eventAt(events, 0, 'grounding')?.grounding?.searchHtml, chipHtml);
  assertEquals(eventAt(events, 1, 'evidence')?.evidence?.raw?.call_id, 'call_s');
  assertEquals(eventAt(events, 1, 'evidence')?.evidence?.raw?.result, [
    { search_suggestions: chipHtml },
  ]);
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
  const primary = {
    title: 'Swansons Nursery - Google Maps',
    uri: 'https://maps.google.com/maps?cid=1',
    placeId: 'ChIJ_primary',
  };
  const other = {
    title: 'Sky Nursery - Google Maps',
    uri: 'https://maps.google.com/maps?cid=2',
    placeId: 'ChIJ_other',
  };
  // A place's review shares its place id: one chunk and one source per place.
  assertEquals(firstOf(events, 'grounding')?.grounding.chunks, [
    { maps: primary },
    { maps: other },
  ]);
  assertEquals(firstOf(events, 'citation')?.sources, [
    { type: 'maps', ...primary },
    { type: 'maps', ...other },
  ]);
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
  const place = {
    title: 'Swansons Nursery - Google Maps',
    uri: 'https://maps.google.com/maps?cid=9',
    placeId: 'ChIJ_cite',
  };
  assertEquals(firstOf(events, 'grounding')?.grounding.chunks, [{ maps: place }]);
  assertEquals(firstOf(events, 'citation')?.sources, [{ type: 'maps', ...place }]);
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
  assertEquals(before, [
    { type: 'tool_draft', callId: 'call_1', name: 'get_soil_moisture', text: '{"plant":' },
    { type: 'tool_draft', callId: 'call_1', name: 'get_soil_moisture', text: '"plant A"}' },
  ]);
  assertEquals(foldPayload(row('step.stop', { index: 1 }), fold), [
    {
      type: 'tool',
      tool: { callId: 'call_1', name: 'get_soil_moisture', arguments: { plant: 'plant A' } },
    },
  ]);
  assertEquals(fold.steps.size, 0);
});

Deno.test('streamed thought_signature delta is reasoning for the first function_call that follows it', () => {
  // Row shapes from gemini-3.1-flash-lite, two parallel calls (probe 25/09/2026).
  const events = foldRows([
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
  ]);
  assertEquals(events, [
    { type: 'tool_draft', callId: 'call_1', name: 'geocode_city', text: '{"city":"Porto"}' },
    {
      type: 'reasoning',
      data: { call: 0, signature: 'sig' },
      origin: { protocol: 'geminiInteractions' },
    },
    {
      type: 'tool',
      tool: { callId: 'call_1', name: 'geocode_city', arguments: { city: 'Porto' } },
    },
    { type: 'tool_draft', callId: 'call_2', name: 'geocode_city', text: '{"city":"Faro"}' },
    { type: 'tool', tool: { callId: 'call_2', name: 'geocode_city', arguments: { city: 'Faro' } } },
  ]);
});

Deno.test('a function_call that carries its own signature keeps it; an empty one takes none', () => {
  assertEquals(
    eventsFromStep(
      { type: 'function_call', id: 'c1', name: 'water', arguments: {}, signature: 'own' },
      newStreamFold(),
    ),
    [
      {
        type: 'reasoning',
        data: { call: 0, signature: 'own' },
        origin: { protocol: 'geminiInteractions' },
      },
      { type: 'tool', tool: { callId: 'c1', name: 'water', arguments: {} } },
    ],
  );
  assertEquals(
    eventsFromStep(
      { type: 'function_call', id: 'c2', name: 'water', arguments: {}, signature: '' },
      newStreamFold(),
    ),
    [{ type: 'tool', tool: { callId: 'c2', name: 'water', arguments: {} } }],
  );
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
    { type: 'tool', tool: { callId: 'call_2', name: 'list_plants', arguments: {} } },
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
  assertEquals(rawCallsOf(events), [{ name: 'water', callId: 'call_3', arguments: {} }]);
  assertEquals(
    toolEventsOf(events, 'error').map((e) => [e.callId, e.failure.code, e.failure.kind]),
    [['call_3', 'malformed_arguments', 'bad_response']],
  );
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
        kind: 'provider_step',
        step: 'function_call',
        partial: true,
      },
    },
  ]);
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
  const fold = newStreamFold();
  assertEquals(
    eventsFromStep({ type: 'user_input', content: [{ type: 'text', text: 'hi' }] }, fold),
    [],
  );
  assertEquals(eventsFromStep({}, fold), []);
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
  assertEquals(eventAt(events, 0, 'error')?.errorInternal, COMBINED_ERROR);
});

function check(actual: unknown, expected: unknown, label: string): void {
  assertEquals({ label, actual }, { label, actual: expected });
}

function startThought(signature: unknown): Record<string, unknown> {
  return row('step.start', { index: 0, step: { type: 'thought', signature } });
}

function callRows(index: number, id: string): Record<string, unknown>[] {
  return [
    row('step.start', { index, step: { id, type: 'function_call', name: 'water', arguments: {} } }),
    row('step.stop', { index }),
  ];
}

function signatureOfOnlyCall(rows: Record<string, unknown>[]): unknown {
  const events = foldRows(rows);
  if (!events.some((e) => e.type === 'tool')) return 'no tool event';
  const reasoning = events.find((e) => e.type === 'reasoning');
  return reasoning?.type === 'reasoning'
    ? (reasoning.data as { signature?: unknown }).signature
    : undefined;
}

Deno.test('a thought signature is held only from a thought, only when non-empty, and survives a bare thought', () => {
  check(
    signatureOfOnlyCall([startThought('sig'), ...callRows(1, 'c')]),
    'sig',
    'thought step.start signature',
  );
  check(
    signatureOfOnlyCall([startThought('sig'), startThought(undefined), ...callRows(1, 'c')]),
    'sig',
    'a thought without a signature leaves the held one',
  );
  check(
    signatureOfOnlyCall([startThought('sig'), startThought(''), ...callRows(1, 'c')]),
    'sig',
    'an empty thought signature leaves the held one',
  );
  check(
    signatureOfOnlyCall([startThought('sig'), startThought(7), ...callRows(1, 'c')]),
    'sig',
    'a non-string thought signature leaves the held one',
  );
  check(
    signatureOfOnlyCall([startThought(7), ...callRows(1, 'c')]),
    undefined,
    'a non-string thought signature is not held',
  );
  check(
    signatureOfOnlyCall([
      row('step.start', { index: 0, step: { type: 'model_output', signature: 'x' } }),
      ...callRows(1, 'c'),
    ]),
    undefined,
    'a step.start that is not a thought holds nothing',
  );
  check(
    signatureOfOnlyCall([
      row('step.delta', { index: 0, delta: { type: 'text', text: 'hi', signature: 'x' } }),
      ...callRows(1, 'c'),
    ]),
    undefined,
    'a delta that is not a thought_signature holds nothing',
  );
});

Deno.test('a call with an empty or non-string own signature takes the held thought signature', () => {
  for (const own of ['', 7]) {
    const fold = newStreamFold();
    eventsFromStep({ type: 'thought', signature: 'held' }, fold);
    check(
      eventsFromStep(
        { type: 'function_call', id: 'c', name: 'water', arguments: {}, signature: own },
        fold,
      ),
      [
        {
          type: 'reasoning',
          data: { call: 0, signature: 'held' },
          origin: { protocol: 'geminiInteractions' },
        },
        { type: 'tool', tool: { callId: 'c', name: 'water', arguments: {} } },
      ],
      `own signature ${JSON.stringify(own)}`,
    );
  }
});

Deno.test('a function_call with a non-string id or name is not trusted', () => {
  const fold = newStreamFold();
  const [withoutId] = eventsFromStep(
    { type: 'function_call', id: 5, name: 'water', arguments: {} },
    fold,
  );
  const callId = withoutId?.type === 'tool' ? withoutId.tool.callId : undefined;
  check(typeof callId === 'string' && callId.startsWith('call_water_'), true, 'generated call id');
  const nameless = eventsFromStep({ type: 'function_call', id: 'c', name: 7, arguments: {} }, fold);
  check(
    toolEventsOf(nameless, 'error').map((e) => [e.callId, e.failure.code]),
    [['c', 'malformed_arguments']],
    'nameless call fails as malformed',
  );
});

Deno.test('streamed steps are keyed by their numeric index, and a missing or non-numeric index is 0', () => {
  const fold = newStreamFold();
  const open = (index: number, id: string) =>
    foldPayload(
      row('step.start', {
        index,
        step: { id, type: 'google_search_call', arguments: { queries: [id] } },
      }),
      fold,
    );
  open(1, 'one');
  open(2, 'two');
  check([...fold.steps.keys()], [1, 2], 'two open steps keep separate indices');
  check(foldPayload(row('step.stop', { index: 2 }), fold).length, 1, 'stopping index 2');
  check([...fold.steps.keys()], [1], 'index 1 is still open');

  const absent = newStreamFold();
  foldPayload(row('step.start', { step: { id: 'z', type: 'google_search_call' } }), absent);
  check([...absent.steps.keys()], [0], 'no index is 0');
  check(foldPayload(row('step.stop', { index: 0 }), absent).length, 1, 'a stop at 0 closes it');
  const text = newStreamFold();
  foldPayload(
    row('step.start', { index: '1', step: { id: 'z', type: 'google_search_call' } }),
    text,
  );
  check([...text.steps.keys()], [0], 'a string index is 0');
});

Deno.test('step rows without a step or delta payload emit nothing', () => {
  const fold = newStreamFold();
  check(foldPayload(row('step.start', { index: 0 }), fold), [], 'step.start without step');
  check(foldPayload(row('step.delta', { index: 0 }), fold), [], 'step.delta without delta');
  check(fold.steps.size, 0, 'nothing opened');
});

Deno.test('an arguments_delta without arguments adds nothing to what arrived', () => {
  const events = foldRows([
    row('step.start', {
      index: 0,
      step: { id: 'c', type: 'function_call', name: 'water', arguments: {} },
    }),
    row('step.delta', { index: 0, delta: { type: 'arguments_delta', arguments: '{"ml":5}' } }),
    row('step.delta', { index: 0, delta: { type: 'arguments_delta' } }),
    row('step.stop', { index: 0 }),
  ]);
  check(
    events,
    [
      { type: 'tool_draft', callId: 'c', name: 'water', text: '{"ml":5}' },
      { type: 'tool', tool: { callId: 'c', name: 'water', arguments: { ml: 5 } } },
    ],
    'args',
  );
});

Deno.test('interaction rows without an interaction emit nothing', () => {
  check(foldRows([row('interaction.created', {}), row('interaction.completed', {})]), [], 'rows');
});

Deno.test('a buffered body skips steps that are not objects and a steps value that is not a list', () => {
  const steps = [null, 'text', { type: 'model_output', content: [{ type: 'text', text: 'ok' }] }];
  check(
    foldBody({ id: 'v1_b', status: 'completed', steps }, newStreamFold()).map((e) => e.type),
    ['response', 'text', 'done'],
    'non-object steps',
  );
  check(
    foldBody({ id: 'v1_b', status: 'completed', steps: 'nope' }, newStreamFold()).map(
      (e) => e.type,
    ),
    ['response', 'done'],
    'steps not a list',
  );
});

Deno.test('a function_call cut off mid-arguments previews them but never becomes a tool call', () => {
  const fold = newStreamFold();
  const events = [
    row('step.start', {
      index: 0,
      step: { id: 'call_1', type: 'function_call', name: 'write_app', arguments: {} },
    }),
    row('step.delta', {
      index: 0,
      delta: { arguments: '{"app_tsx":"imp', type: 'arguments_delta' },
    }),
  ].flatMap((r) => foldPayload(r, fold));
  assertEquals(events, [
    { type: 'tool_draft', callId: 'call_1', name: 'write_app', text: '{"app_tsx":"imp' },
  ]);
  assertEquals(
    openStepEvents(fold).map((event) => event.type),
    ['evidence'],
  );
});
