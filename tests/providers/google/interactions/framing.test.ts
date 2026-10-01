import '../../../fixtures/test-host.ts';
import { assertEquals, assertThrows } from '@std/assert';
import { TheoremError } from '../../../../src/guardrails/error.ts';
import type {
  InteractionPart,
  ProviderCompleteRequest,
  TurnHistoryMessage,
} from '../../../../src/kernel/types.ts';
import {
  applyOptionalRequestFields,
  attachResponseFormat,
  attachSpeechConfig,
  baseInteractionsBody,
  camelToSnake,
  historyStep,
  historySteps,
  inputStepsFromRequest,
  jsonResponseFormat,
  toGoogleValue,
  toInteractionsBody,
  userInputStep,
  wirePart,
} from '../../../../src/providers/google/interactions/framing.ts';
import { googleBuiltins, resolvedStructured } from '../../../fixtures/provider-request.ts';
import { testWireTool } from '../../../fixtures/wire-tools.ts';

function baseReq(overrides: Partial<ProviderCompleteRequest> = {}): ProviderCompleteRequest {
  return {
    model: 'gemini35FlashLite',
    apiId: 'gemini-3.5-flash-lite',
    thinking: 'low',
    summaries: 'none',
    maxOutputTokens: 100,
    temperature: 0.5,
    builtins: [],
    system: '',
    input: [{ type: 'text', text: 'hi' }],
    structured: null,
    image: null,
    ...overrides,
  };
}

Deno.test('camelToSnake converts a single camelCase boundary', () => {
  assertEquals(camelToSnake('mimeType'), 'mime_type');
});

Deno.test('camelToSnake converts multiple camelCase boundaries', () => {
  assertEquals(camelToSnake('previousInteractionId'), 'previous_interaction_id');
});

Deno.test('camelToSnake leaves already-snake or lowercase keys unchanged', () => {
  assertEquals(camelToSnake('model'), 'model');
  assertEquals(camelToSnake('already_snake'), 'already_snake');
});

Deno.test('toGoogleValue snake_cases nested object keys', () => {
  const result = toGoogleValue({ maxOutputTokens: 10, nested: { thinkingLevel: 'low' } });
  assertEquals(result, { max_output_tokens: 10, nested: { thinking_level: 'low' } });
});

Deno.test('toGoogleValue maps over arrays recursively', () => {
  const result = toGoogleValue([{ mimeType: 'a' }, { mimeType: 'b' }]);
  assertEquals(result, [{ mime_type: 'a' }, { mime_type: 'b' }]);
});

Deno.test('toGoogleValue returns primitives unchanged', () => {
  assertEquals(toGoogleValue('text'), 'text');
  assertEquals(toGoogleValue(5), 5);
  assertEquals(toGoogleValue(null), null);
  assertEquals(toGoogleValue(undefined), undefined);
});

Deno.test('toGoogleValue preserves authored property names inside a schema key', () => {
  const result = toGoogleValue({
    schema: {
      properties: { correctAnswer: { type: 'string' } },
      required: ['correctAnswer'],
    },
  }) as Record<string, unknown>;
  assertEquals(result.schema, {
    properties: { correctAnswer: { type: 'string' } },
    required: ['correctAnswer'],
  });
});

Deno.test('toGoogleValue snake_cases the schema key itself but not its contents', () => {
  const result = toGoogleValue({
    responseSchema: { schema: { camelInside: true } },
  }) as Record<string, unknown>;
  const nested = result.response_schema as Record<string, unknown>;
  assertEquals(Object.hasOwn(nested, 'schema'), true);
  assertEquals(nested.schema, { camelInside: true });
});

Deno.test('wirePart converts a text part to wire shape', () => {
  const part: InteractionPart = { type: 'text', text: 'hello' };
  assertEquals(wirePart(part), { type: 'text', text: 'hello' });
});

Deno.test('wirePart converts a media part to wire shape', () => {
  const part: InteractionPart = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' };
  assertEquals(wirePart(part), { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' });
});

Deno.test('userInputStep wraps parts under a user_input step', () => {
  const parts: InteractionPart[] = [{ type: 'text', text: 'hi' }];
  assertEquals(userInputStep(parts), {
    type: 'user_input',
    content: [{ type: 'text', text: 'hi' }],
  });
});

Deno.test('userInputStep supports an empty parts list', () => {
  assertEquals(userInputStep([]), { type: 'user_input', content: [] });
});

Deno.test('historyStep maps assistant role to model_output', () => {
  const msg: TurnHistoryMessage = { role: 'assistant', content: 'It is fine.' };
  assertEquals(historyStep(msg), {
    type: 'model_output',
    content: [{ type: 'text', text: 'It is fine.' }],
  });
});

Deno.test('historyStep maps user role to user_input', () => {
  const msg: TurnHistoryMessage = { role: 'user', content: 'What is this?' };
  assertEquals(historyStep(msg), {
    type: 'user_input',
    content: [{ type: 'text', text: 'What is this?' }],
  });
});

Deno.test('historyStep sends content first, then parts', () => {
  const msg: TurnHistoryMessage = {
    role: 'user',
    content: 'from content',
    parts: [{ type: 'text', text: 'from parts' }],
  };
  assertEquals(historyStep(msg), {
    type: 'user_input',
    content: [
      { type: 'text', text: 'from content' },
      { type: 'text', text: 'from parts' },
    ],
  });
});

Deno.test('historySteps keeps assistant content and parts ahead of function calls', () => {
  const steps = historySteps({
    role: 'assistant',
    content: 'Checking the forecast.',
    parts: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0=' }],
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
  });
  assertEquals(steps, [
    {
      type: 'model_output',
      content: [
        { type: 'text', text: 'Checking the forecast.' },
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0=' },
      ],
    },
    { type: 'function_call', id: 'c1', name: 'weather', arguments: {} },
  ]);
});

Deno.test('historyStep falls back to empty text when content is missing', () => {
  const msg: TurnHistoryMessage = { role: 'user' };
  assertEquals(historyStep(msg), { type: 'user_input', content: [{ type: 'text', text: '' }] });
});

Deno.test('historyStep treats an empty parts array as absent and falls back to content', () => {
  const msg: TurnHistoryMessage = { role: 'user', content: 'text fallback', parts: [] };
  assertEquals(historyStep(msg), {
    type: 'user_input',
    content: [{ type: 'text', text: 'text fallback' }],
  });
});

Deno.test('jsonResponseFormat wraps a schema in a text/json response format entry', () => {
  const schema = { type: 'object' };
  assertEquals(jsonResponseFormat(schema), [
    { type: 'text', mimeType: 'application/json', schema },
  ]);
});

Deno.test('attachResponseFormat throws when speech and image are both requested', () => {
  const req = baseReq({
    speech: { voice: 'Kore' },
    image: {
      type: 'image',
      mimeType: 'image/png',
      aspectRatio: '1:1',
      size: '1K',
      includeText: false,
    },
  });
  assertThrows(() => attachResponseFormat(req, {}), TheoremError);
});

Deno.test('attachResponseFormat throws when speech and structured are both requested', () => {
  const req = baseReq({ speech: { voice: 'Kore' }, structured: resolvedStructured('chatTurn') });
  assertThrows(() => attachResponseFormat(req, {}), TheoremError);
});

Deno.test('attachResponseFormat sets an audio response format for speech-only requests', () => {
  const req = baseReq({ speech: { voice: 'Kore' } });
  const camel: Record<string, unknown> = {};
  attachResponseFormat(req, camel);
  assertEquals(camel.responseFormat, { type: 'audio' });
  assertEquals(camel.responseModalities, ['audio']);
});

Deno.test('attachResponseFormat refuses a speech format Gemini cannot return', () => {
  const camel: Record<string, unknown> = {};
  attachResponseFormat(baseReq({ speech: { voice: 'Kore', format: 'pcm' } }), camel);
  assertEquals(camel.responseFormat, { type: 'audio' });
  const refused = assertThrows(
    () => attachResponseFormat(baseReq({ speech: { voice: 'Kore', format: 'mp3' } }), {}),
    TheoremError,
    "not 'mp3'",
  );
  assertEquals(refused.kind, 'unsupported');
});

Deno.test('attachResponseFormat sets an image-only response format by default', () => {
  const req = baseReq({
    image: {
      type: 'image',
      mimeType: 'image/png',
      aspectRatio: '16:9',
      size: '2K',
      includeText: false,
    },
  });
  const camel: Record<string, unknown> = {};
  attachResponseFormat(req, camel);
  assertEquals(camel.responseFormat, {
    type: 'image',
    mimeType: 'image/png',
    aspectRatio: '16:9',
    imageSize: '2K',
  });
  assertEquals(Object.hasOwn(camel, 'responseModalities'), false);
});

Deno.test('attachResponseFormat omits aspect and size when image pins are unset', () => {
  const req = baseReq({
    image: {
      type: 'image',
      mimeType: 'image/png',
      includeText: false,
    },
  });
  const camel: Record<string, unknown> = {};
  attachResponseFormat(req, camel);
  assertEquals(camel.responseFormat, {
    type: 'image',
    mimeType: 'image/png',
  });
});

Deno.test('attachResponseFormat sets text and image response formats when includeText is true', () => {
  const req = baseReq({
    image: {
      type: 'image',
      mimeType: 'image/png',
      aspectRatio: '16:9',
      size: '2K',
      includeText: true,
    },
  });
  const camel: Record<string, unknown> = {};
  attachResponseFormat(req, camel);
  assertEquals(camel.responseFormat, [
    { type: 'text' },
    {
      type: 'image',
      mimeType: 'image/png',
      aspectRatio: '16:9',
      imageSize: '2K',
    },
  ]);
  assertEquals(Object.hasOwn(camel, 'responseModalities'), false);
});

Deno.test('attachResponseFormat leaves camel untouched when nothing is requested', () => {
  const req = baseReq();
  const camel: Record<string, unknown> = {};
  attachResponseFormat(req, camel);
  assertEquals(Object.hasOwn(camel, 'responseFormat'), false);
});

Deno.test('attachResponseFormat sets json response format for a structured schema', () => {
  const req = baseReq({ structured: resolvedStructured('chatTurn') });
  const camel: Record<string, unknown> = {};
  attachResponseFormat(req, camel);
  assertEquals(Array.isArray(camel.responseFormat), true);
});

Deno.test('attachSpeechConfig does nothing when speech is absent', () => {
  const req = baseReq();
  const generationConfig: Record<string, unknown> = {};
  attachSpeechConfig(req, generationConfig);
  assertEquals(generationConfig, {});
});

Deno.test('attachSpeechConfig does nothing when speech has no voice', () => {
  const req = baseReq({ speech: {} });
  const generationConfig: Record<string, unknown> = {};
  attachSpeechConfig(req, generationConfig);
  assertEquals(generationConfig, {});
});

Deno.test('attachSpeechConfig sets speechConfig from the requested voice', () => {
  const req = baseReq({ speech: { voice: 'Kore' } });
  const generationConfig: Record<string, unknown> = {};
  attachSpeechConfig(req, generationConfig);
  assertEquals(generationConfig.speechConfig, [{ voice: 'Kore' }]);
});

Deno.test('inputStepsFromRequest emits history steps followed by user input', () => {
  const req = baseReq({
    history: [{ role: 'user', content: 'earlier' }],
    input: [{ type: 'text', text: 'now' }],
  });
  const steps = inputStepsFromRequest(req);
  assertEquals(steps.length, 2);
  const firstContent = steps[0]?.content as Array<{ text?: string }> | undefined;
  const secondContent = steps[1]?.content as Array<{ text?: string }> | undefined;
  assertEquals(firstContent?.[0]?.text, 'earlier');
  assertEquals(secondContent?.[0]?.text, 'now');
});

Deno.test('a tool result without a name takes its call name', () => {
  const call: TurnHistoryMessage = {
    role: 'assistant',
    tool_calls: [{ id: 't1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
  };
  const result: TurnHistoryMessage = { role: 'tool', tool_call_id: 't1', content: 'ok' };
  const orphan: TurnHistoryMessage = { role: 'tool', tool_call_id: 't9', content: 'ok' };
  const results = (req: ProviderCompleteRequest) =>
    inputStepsFromRequest(req).filter((step) => step.type === 'function_result');
  assertEquals(
    results(baseReq({ history: [call, result, orphan], input: [] })).map((step) => step.name),
    ['lookup', undefined],
  );
  assertEquals(
    results(baseReq({ continuation: [call, result], input: [] })).map((step) => step.name),
    ['lookup'],
  );
});

Deno.test('inputStepsFromRequest omits user input when history exists and input is empty', () => {
  const req = baseReq({
    history: [{ role: 'user', content: 'earlier' }],
    input: [],
  });
  const steps = inputStepsFromRequest(req);
  assertEquals(steps.length, 1);
});

Deno.test('inputStepsFromRequest forces a user input step when there is no history and no input', () => {
  const req = baseReq({ history: [], input: [] });
  const steps = inputStepsFromRequest(req);
  assertEquals(steps.length, 1);
  assertEquals(steps[0]?.type, 'user_input');
  assertEquals(steps[0]?.content, []);
});

Deno.test('applyOptionalRequestFields sets store, previousInteractionId, and system', () => {
  const req = baseReq({ store: false, previousInteractionId: 'v1_x', system: 'sys' });
  const camel: Record<string, unknown> = {};
  applyOptionalRequestFields(req, camel);
  assertEquals(camel.store, false);
  assertEquals(camel.previousInteractionId, 'v1_x');
  assertEquals(camel.systemInstruction, 'sys');
});

Deno.test('applyOptionalRequestFields omits optional fields when absent', () => {
  const req = baseReq();
  const camel: Record<string, unknown> = {};
  applyOptionalRequestFields(req, camel);
  assertEquals(Object.hasOwn(camel, 'store'), false);
  assertEquals(Object.hasOwn(camel, 'previousInteractionId'), false);
  assertEquals(Object.hasOwn(camel, 'systemInstruction'), false);
  assertEquals(Object.hasOwn(camel, 'tools'), false);
});

Deno.test('applyOptionalRequestFields maps builtins to their Interactions wire types', () => {
  const req = baseReq({ builtins: googleBuiltins('googleSearch', 'urlContext') });
  const camel: Record<string, unknown> = {};
  applyOptionalRequestFields(req, camel);
  assertEquals(camel.tools, [{ type: 'google_search' }, { type: 'url_context' }]);
});

Deno.test('applyOptionalRequestFields merges codeExecution builtin with dynamic function tools', () => {
  const req = baseReq({
    builtins: googleBuiltins('codeExecution', 'googleSearch'),
    wireTools: [
      testWireTool('lookup_order', {
        description: 'Fetch order state',
        parameters: {
          type: 'object',
          properties: { orderId: { type: 'string' } },
          required: ['orderId'],
        },
      }),
    ],
  });
  const camel: Record<string, unknown> = {};
  applyOptionalRequestFields(req, camel);
  assertEquals(camel.tools, [
    { type: 'code_execution' },
    { type: 'google_search' },
    {
      type: 'function',
      name: 'lookup_order',
      description: 'Fetch order state',
      parameters: {
        type: 'object',
        properties: { orderId: { type: 'string' } },
        required: ['orderId'],
      },
    },
  ]);
});

Deno.test('toGoogleValue preserves JSON Schema property names inside parameters', () => {
  const result = toGoogleValue({
    tools: [
      {
        type: 'function',
        name: 'lookup_order',
        parameters: {
          type: 'object',
          properties: { orderId: { type: 'string' } },
          required: ['orderId'],
        },
      },
    ],
  }) as Record<string, unknown>;
  const tools = result.tools as Record<string, unknown>[];
  const params = tools[0]?.parameters as Record<string, unknown>;
  assertEquals(params.properties, { orderId: { type: 'string' } });
  assertEquals(params.required, ['orderId']);
});

Deno.test('inputStepsFromRequest maps continuation messages like history', () => {
  const req = baseReq({
    history: [{ role: 'user', content: 'old' }],
    input: [{ type: 'text', text: 'ignored' }],
    continuation: [
      { role: 'tool', name: 'lookup_order', tool_call_id: 'call_1', content: 'ok' },
      { role: 'user', content: 'Also check stock' },
    ],
  });
  assertEquals(inputStepsFromRequest(req), [
    {
      type: 'function_result',
      name: 'lookup_order',
      call_id: 'call_1',
      result: [{ type: 'text', text: 'ok' }],
    },
    { type: 'user_input', content: [{ type: 'text', text: 'Also check stock' }] },
  ]);
});

Deno.test('historySteps rejects history tool calls with malformed arguments', () => {
  for (const args of ['not json', '[1]', '"text"']) {
    assertThrows(
      () =>
        historySteps({
          role: 'assistant',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: args } },
          ],
        }),
      TheoremError,
    );
  }
});

Deno.test('historyStep maps tool role messages to function_result steps', () => {
  const step = historyStep({
    role: 'tool',
    name: 'lookup_order',
    tool_call_id: 'call_1',
    content: 'done',
  });
  assertEquals(step, {
    type: 'function_result',
    name: 'lookup_order',
    call_id: 'call_1',
    result: [{ type: 'text', text: 'done' }],
  });
});

Deno.test('historyStep sends only the tool identity history carries', () => {
  assertEquals(historyStep({ role: 'tool', content: 'done' }), {
    type: 'function_result',
    result: [{ type: 'text', text: 'done' }],
  });
});

Deno.test('historyStep maps tool role content and parts through wirePart', () => {
  const step = historyStep({
    role: 'tool',
    name: 'fetch_stock_media',
    tool_call_id: 'call_media',
    content: 'shortlist\n{"items":[]}',
    parts: [
      { type: 'text', text: '1. palm' },
      { type: 'image', mimeType: 'image/jpeg', data: '/9j/abc' },
      { type: 'audio', mimeType: 'audio/wav', data: 'UklG' },
    ],
  });
  assertEquals(step, {
    type: 'function_result',
    name: 'fetch_stock_media',
    call_id: 'call_media',
    result: [
      { type: 'text', text: 'shortlist\n{"items":[]}' },
      { type: 'text', text: '1. palm' },
      { type: 'image', mimeType: 'image/jpeg', data: '/9j/abc' },
      { type: 'audio', mimeType: 'audio/wav', data: 'UklG' },
    ],
  });
});

Deno.test('historySteps maps assistant tool_calls to function_call (no empty text)', () => {
  const steps = historySteps({
    role: 'assistant',
    tool_calls: [
      {
        id: 'call_plan',
        type: 'function',
        function: { name: 'plan_day', arguments: '{"destination":"Tokyo"}' },
      },
    ],
  });
  assertEquals(steps, [
    {
      type: 'function_call',
      id: 'call_plan',
      name: 'plan_day',
      arguments: { destination: 'Tokyo' },
    },
  ]);
});

Deno.test('historySteps replays the thought signature as the thought step ahead of the calls', () => {
  const steps = historySteps({
    role: 'assistant',
    tool_calls: [
      {
        id: 'c1',
        type: 'function',
        function: { name: 'geocode_city', arguments: '{"city":"Porto"}' },
        thoughtSignature: 'sig',
      },
      {
        id: 'c2',
        type: 'function',
        function: { name: 'geocode_city', arguments: '{"city":"Faro"}' },
      },
    ],
  });
  assertEquals(steps, [
    { type: 'thought', signature: 'sig' },
    { type: 'function_call', id: 'c1', name: 'geocode_city', arguments: { city: 'Porto' } },
    { type: 'function_call', id: 'c2', name: 'geocode_city', arguments: { city: 'Faro' } },
  ]);
});

Deno.test('historySteps keeps preceding assistant prose then function_call', () => {
  const steps = historySteps({
    role: 'assistant',
    content: 'One moment.',
    tool_calls: [
      {
        id: 'c1',
        type: 'function',
        function: { name: 'plan_day', arguments: '{}' },
      },
    ],
  });
  assertEquals(steps[0], {
    type: 'model_output',
    content: [{ type: 'text', text: 'One moment.' }],
  });
  assertEquals(steps[1], {
    type: 'function_call',
    id: 'c1',
    name: 'plan_day',
    arguments: {},
  });
});

Deno.test('inputStepsFromRequest expands tool_calls history into function_call + function_result', () => {
  const req = baseReq({
    history: [
      { role: 'user', content: 'Plan Tokyo' },
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'plan_day', arguments: '{"destination":"Tokyo"}' },
          },
        ],
      },
      {
        role: 'tool',
        name: 'plan_day',
        tool_call_id: 'call_1',
        content: '{"summary":"ok"}',
      },
    ],
    input: [{ type: 'text', text: 'How far between stops?' }],
  });
  const steps = inputStepsFromRequest(req);
  assertEquals(
    steps.map((s) => s.type),
    ['user_input', 'function_call', 'function_result', 'user_input'],
  );
  assertEquals(steps[1], {
    type: 'function_call',
    id: 'call_1',
    name: 'plan_day',
    arguments: { destination: 'Tokyo' },
  });
  assertEquals(steps[2]?.type, 'function_result');
});

Deno.test('applyOptionalRequestFields throws for a builtin with no Interactions wire type', () => {
  const req = baseReq({ builtins: [{ id: 'liveOnly', wire: { live: 'liveOnly' } }] });
  assertThrows(() => applyOptionalRequestFields(req, {}), TheoremError);
});

Deno.test('baseInteractionsBody sets thinking knobs outside of speech requests', () => {
  const req = baseReq({ thinking: 'high', summaries: 'auto' });
  const body = baseInteractionsBody(req);
  const config = body.generationConfig as Record<string, unknown>;
  assertEquals(body.model, 'gemini-3.5-flash-lite');
  assertEquals(body.stream, true);
  assertEquals(config.thinkingLevel, 'high');
  assertEquals(config.thinkingSummaries, 'auto');
  assertEquals(Object.hasOwn(config, 'speechConfig'), false);
});

Deno.test('baseInteractionsBody swaps in speech config and omits thinking knobs for speech', () => {
  const req = baseReq({ speech: { voice: 'Kore' } });
  const body = baseInteractionsBody(req);
  const config = body.generationConfig as Record<string, unknown>;
  assertEquals(config.speechConfig, [{ voice: 'Kore' }]);
  assertEquals(Object.hasOwn(config, 'thinkingLevel'), false);
  assertEquals(Object.hasOwn(config, 'thinkingSummaries'), false);
});

Deno.test('toInteractionsBody builds a full snake_case wire body', () => {
  const req = baseReq({
    system: 'be nice',
    store: true,
    builtins: googleBuiltins('googleSearch'),
    structured: resolvedStructured('chatTurn'),
  });
  const body = toInteractionsBody(req);
  assertEquals(body.model, 'gemini-3.5-flash-lite');
  assertEquals(body.stream, true);
  assertEquals(body.store, true);
  assertEquals(body.system_instruction, 'be nice');
  assertEquals(body.tools, [{ type: 'google_search' }]);
  assertEquals(Array.isArray(body.response_format), true);
  const input = body.input as Array<{ type: string; content: unknown[] }>;
  assertEquals(input[0]?.type, 'user_input');
});

Deno.test('toInteractionsBody sets stream false when requested', () => {
  const body = toInteractionsBody(baseReq({ stream: false }));
  assertEquals(body.stream, false);
});

Deno.test('toInteractionsBody sends code_execution together with structured response_format', () => {
  const body = toInteractionsBody(
    baseReq({
      builtins: googleBuiltins('codeExecution'),
      structured: resolvedStructured('chatTurn'),
    }),
  );
  assertEquals(body.tools, [{ type: 'code_execution' }]);
  assertEquals(Array.isArray(body.response_format), true);
});

Deno.test('Interactions wires a media reference as { type, uri, mime_type } (Files API input)', () => {
  const ref: InteractionPart = { type: 'video', mimeType: 'video/mp4', uri: 'files/abc123' };
  assertEquals(wirePart(ref), { type: 'video', mimeType: 'video/mp4', uri: 'files/abc123' });
  assertEquals(toGoogleValue(userInputStep([ref])), {
    type: 'user_input',
    content: [{ type: 'video', mime_type: 'video/mp4', uri: 'files/abc123' }],
  });
  const body = toInteractionsBody(baseReq({ input: [{ type: 'text', text: 'describe' }, ref] }));
  const input = body.input as Array<{ type: string; content: Array<Record<string, unknown>> }>;
  const userStep = input.find((step) => step.type === 'user_input');
  assertEquals(userStep?.content.at(-1), {
    type: 'video',
    mime_type: 'video/mp4',
    uri: 'files/abc123',
  });
  assertEquals(JSON.stringify(body).includes('file_uri'), false);
});

Deno.test('baseInteractionsBody sends an image seed as generationConfig.seed', () => {
  const req = baseReq({ image: { type: 'image', includeText: false, seed: 9 } });
  assertEquals((baseInteractionsBody(req).generationConfig as Record<string, unknown>).seed, 9);
});

Deno.test('attachResponseFormat refuses image pins Google cannot send', () => {
  for (const pin of [
    { quality: 'high' },
    { background: 'opaque' },
    { n: 2 },
    { outputCompression: 50 },
  ]) {
    const req = baseReq({ image: { type: 'image', includeText: false, ...pin } });
    assertThrows(() => attachResponseFormat(req, {}), TheoremError);
  }
});

Deno.test('baseInteractionsBody refuses a thinking level Gemini does not take', () => {
  for (const level of ['none', 'xhigh', 'max'] as const) {
    assertThrows(() => baseInteractionsBody(baseReq({ thinking: level })), TheoremError, level);
  }
  baseInteractionsBody(baseReq({ thinking: 'high' }));
});
