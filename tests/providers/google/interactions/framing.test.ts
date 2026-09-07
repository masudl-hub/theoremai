import '../../../fixtures/test-host.ts';
import { assertEquals, assertThrows } from '@std/assert';
import { TheorumError } from '../../../../src/guardrails/error.ts';
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
  inputStepsFromRequest,
  jsonResponseFormat,
  systemHoldsUserInput,
  toGoogleValue,
  toInteractionsBody,
  userInputStep,
  wirePart,
} from '../../../../src/providers/google/interactions/framing.ts';
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

// camelToSnake

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

// toGoogleValue

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

// wirePart

Deno.test('wirePart converts a text part to wire shape', () => {
  const part: InteractionPart = { type: 'text', text: 'hello' };
  assertEquals(wirePart(part), { type: 'text', text: 'hello' });
});

Deno.test('wirePart converts a media part to wire shape', () => {
  const part: InteractionPart = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' };
  assertEquals(wirePart(part), { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' });
});

// userInputStep

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

// historyStep

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

Deno.test('historyStep prefers parts over content when parts are present', () => {
  const msg: TurnHistoryMessage = {
    role: 'user',
    content: 'ignored',
    parts: [{ type: 'text', text: 'from parts' }],
  };
  assertEquals(historyStep(msg), {
    type: 'user_input',
    content: [{ type: 'text', text: 'from parts' }],
  });
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

// systemHoldsUserInput

Deno.test('systemHoldsUserInput returns true when a text part is embedded in system', () => {
  const parts: InteractionPart[] = [{ type: 'text', text: 'secret' }];
  assertEquals(systemHoldsUserInput('prefix secret suffix', parts), true);
});

Deno.test('systemHoldsUserInput returns false when no text part is in system', () => {
  const parts: InteractionPart[] = [{ type: 'text', text: 'secret' }];
  assertEquals(systemHoldsUserInput('unrelated system prompt', parts), false);
});

Deno.test('systemHoldsUserInput ignores non-text parts and empty text', () => {
  const parts: InteractionPart[] = [
    { type: 'image', mimeType: 'image/png', data: 'x' },
    { type: 'text', text: '' },
  ];
  assertEquals(systemHoldsUserInput('anything', parts), false);
});

// jsonResponseFormat

Deno.test('jsonResponseFormat wraps a schema in a text/json response format entry', () => {
  const schema = { type: 'object' };
  assertEquals(jsonResponseFormat(schema), [
    { type: 'text', mimeType: 'application/json', schema },
  ]);
});

// attachResponseFormat

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
  assertThrows(() => attachResponseFormat(req, {}), TheorumError);
});

Deno.test('attachResponseFormat throws when speech and structured are both requested', () => {
  const req = baseReq({ speech: { voice: 'Kore' }, structured: 'chatTurn' });
  assertThrows(() => attachResponseFormat(req, {}), TheorumError);
});

Deno.test('attachResponseFormat sets an audio response format for speech-only requests', () => {
  const req = baseReq({ speech: { voice: 'Kore' } });
  const camel: Record<string, unknown> = {};
  attachResponseFormat(req, camel);
  assertEquals(camel.responseFormat, { type: 'audio' });
  assertEquals(camel.responseModalities, ['audio']);
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

Deno.test('attachResponseFormat sets json response format for a responseFormat-enforced schema', () => {
  const req = baseReq({ structured: 'chatTurn' });
  const camel: Record<string, unknown> = {};
  attachResponseFormat(req, camel);
  assertEquals(Array.isArray(camel.responseFormat), true);
});

Deno.test('attachResponseFormat skips prompt-enforced structured schemas', () => {
  const req = baseReq({ structured: 'promptTurn' });
  const camel: Record<string, unknown> = {};
  attachResponseFormat(req, camel);
  assertEquals(Object.hasOwn(camel, 'responseFormat'), false);
});

// attachSpeechConfig

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

// inputStepsFromRequest

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

// applyOptionalRequestFields

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
  const req = baseReq({ builtins: ['googleSearch', 'urlContext'] });
  const camel: Record<string, unknown> = {};
  applyOptionalRequestFields(req, camel);
  assertEquals(camel.tools, [{ type: 'google_search' }, { type: 'url_context' }]);
});

Deno.test('applyOptionalRequestFields merges codeExecution builtin with dynamic function tools', () => {
  const req = baseReq({
    builtins: ['codeExecution', 'googleSearch'],
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

Deno.test('inputStepsFromRequest uses interactionOnlyInput when provided', () => {
  const req = baseReq({
    history: [{ role: 'user', content: 'old' }],
    input: [{ type: 'text', text: 'ignored' }],
    interactionOnlyInput: [
      {
        type: 'function_result',
        name: 'lookup_order',
        call_id: 'call_1',
        result: [{ type: 'text', text: 'ok' }],
      },
    ],
  });
  const steps = inputStepsFromRequest(req);
  assertEquals(steps.length, 1);
  assertEquals(steps[0]?.type, 'function_result');
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

Deno.test('applyOptionalRequestFields throws for a builtin with no Interactions wire type', () => {
  const req = baseReq({ builtins: ['notRegisteredTool'] });
  assertThrows(() => applyOptionalRequestFields(req, {}), TheorumError);
});

// baseInteractionsBody

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

// toInteractionsBody

Deno.test('toInteractionsBody rejects a system prompt that already contains user input', () => {
  const req = baseReq({
    system: 'leaked hi text',
    input: [{ type: 'text', text: 'hi' }],
  });
  assertThrows(() => toInteractionsBody(req), TheorumError);
});

Deno.test('toInteractionsBody builds a full snake_case wire body', () => {
  const req = baseReq({
    system: 'be nice',
    store: true,
    builtins: ['googleSearch'],
    structured: 'chatTurn',
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
      builtins: ['codeExecution'],
      structured: 'chatTurn',
    }),
  );
  assertEquals(body.tools, [{ type: 'code_execution' }]);
  assertEquals(Array.isArray(body.response_format), true);
});
