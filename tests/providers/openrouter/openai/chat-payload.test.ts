import { assertEquals } from '@std/assert';
import { registerStructured } from '../../../../src/kernel/registry/schemas.ts';
import type { ModelId, ProviderCompleteRequest } from '../../../../src/kernel/types.ts';
import { registerGooglePreset } from '../../../../src/presets/google.ts';
import { toOpenAiChatPayload } from '../../../../src/providers/openrouter/openai/chat-payload.ts';
import { HOST_MODELS } from '../../../fixtures/models.ts';

registerGooglePreset();

Deno.test('toOpenAiChatPayload passes apiId through unchanged', () => {
  const req: ProviderCompleteRequest = {
    model: 'perplexity/sonar:online' as ModelId,
    apiId: 'perplexity/sonar:online',
    system: '',
    summaries: undefined,
    image: null,
    input: [{ type: 'text', text: 'Research this' }],
    history: [],
    thinking: 'none',
    maxOutputTokens: 1024,
    temperature: 0,
    builtins: [],
    wireTools: [],
    structured: null,
  };

  const payload = toOpenAiChatPayload(req);
  assertEquals(payload.model, 'perplexity/sonar:online');
});

Deno.test('toOpenAiChatPayload builds correct system and user messages', () => {
  const req: ProviderCompleteRequest = {
    model: 'gemini35FlashLite',
    apiId: HOST_MODELS.gemini35FlashLite.apiId,
    system: 'Be helpful',
    summaries: undefined,
    image: null,
    input: [{ type: 'text', text: 'Hello' }],
    history: [],
    thinking: 'none',
    maxOutputTokens: 1024,
    temperature: 0.5,
    builtins: [],
    wireTools: [],
    structured: null,
  };

  const payload = toOpenAiChatPayload(req);
  const messages = payload.messages as Array<Record<string, unknown>>;

  assertEquals(messages.length, 2);
  assertEquals(messages[0], { role: 'system', content: 'Be helpful' });
  assertEquals(messages[1], { role: 'user', content: 'Hello' });
});

Deno.test('toOpenAiChatPayload wires multimodal user input with image, audio, and document parts', () => {
  const req: ProviderCompleteRequest = {
    model: 'gemini35FlashLite',
    apiId: HOST_MODELS.gemini35FlashLite.apiId,
    system: '',
    summaries: undefined,
    image: null,
    input: [
      { type: 'text', text: 'Look at this' },
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      { type: 'audio', mimeType: 'audio/wav', data: 'UklGRi===' },
      { type: 'audio', mimeType: 'audio/mp3', data: 'SUQzBA===' },
      { type: 'document', mimeType: 'application/pdf', data: 'JVBERi0=' },
    ],
    history: [],
    thinking: 'none',
    maxOutputTokens: 1024,
    temperature: 0,
    builtins: [],
    wireTools: [],
    structured: null,
  };

  const payload = toOpenAiChatPayload(req);
  const messages = payload.messages as Array<Record<string, unknown>>;
  const userMsg = messages[messages.length - 1];
  const content = userMsg.content as Array<Record<string, unknown>>;

  assertEquals(content[0], { type: 'text', text: 'Look at this' });
  assertEquals(content[1], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
  });
  assertEquals(content[2], {
    type: 'input_audio',
    input_audio: { data: 'UklGRi===', format: 'wav' },
  });
  assertEquals(content[3], {
    type: 'input_audio',
    input_audio: { data: 'SUQzBA===', format: 'mp3' },
  });
  assertEquals(content[4], { type: 'text', text: '' });
});

Deno.test('toOpenAiChatPayload wires history messages with parts, tool_calls, tool results, and plain text', () => {
  const req: ProviderCompleteRequest = {
    model: 'gemini35FlashLite',
    apiId: HOST_MODELS.gemini35FlashLite.apiId,
    system: '',
    summaries: undefined,
    image: null,
    input: [{ type: 'text', text: 'next' }],
    history: [
      { role: 'user', content: 'plain text message' },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'part A' },
          { type: 'text', text: 'part B' },
        ],
      },
      {
        role: 'assistant',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'calc', arguments: '{"x":1}' } },
        ],
      },
      { role: 'tool', name: 'calc', tool_call_id: 'call_1', content: '42' },
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'with image' },
          { type: 'image', mimeType: 'image/jpeg', data: '/9j/4AAQ' },
        ],
      },
    ],
    thinking: 'none',
    maxOutputTokens: 1024,
    temperature: 0,
    builtins: [],
    wireTools: [],
    structured: null,
  };

  const payload = toOpenAiChatPayload(req);
  const messages = payload.messages as Array<Record<string, unknown>>;

  assertEquals(messages[0], { role: 'user', content: 'plain text message' });
  assertEquals(messages[1], { role: 'assistant', content: 'part A\npart B' });

  const toolCallMsg = messages[2];
  assertEquals(toolCallMsg.role, 'assistant');
  assertEquals(toolCallMsg.content, '');
  assertEquals(toolCallMsg.tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'calc', arguments: '{"x":1}' } },
  ]);

  const toolResultMsg = messages[3];
  assertEquals(toolResultMsg.role, 'tool');
  assertEquals(toolResultMsg.name, 'calc');
  assertEquals(toolResultMsg.tool_call_id, 'call_1');
  assertEquals(toolResultMsg.content, '42');

  const multimodalUser = messages[4];
  assertEquals(multimodalUser.role, 'user');
  const parts = multimodalUser.content as Array<Record<string, unknown>>;
  assertEquals(parts[0], { type: 'text', text: 'with image' });
  assertEquals(parts[1], {
    type: 'image_url',
    image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' },
  });
});

Deno.test('toOpenAiChatPayload formats tools with name, description, and parameters', () => {
  const req: ProviderCompleteRequest = {
    model: 'gemini35FlashLite',
    apiId: HOST_MODELS.gemini35FlashLite.apiId,
    system: '',
    summaries: undefined,
    image: null,
    input: [{ type: 'text', text: 'go' }],
    history: [],
    thinking: 'none',
    maxOutputTokens: 1024,
    temperature: 0,
    builtins: [],
    wireTools: [
      {
        type: 'function',
        name: 'bareTool',
        description: '',
        parameters: { type: 'object', properties: {} },
      },
      {
        type: 'function',
        name: 'fullTool',
        description: 'A full tool',
        parameters: { type: 'object', properties: { x: { type: 'string' } } },
      },
    ],
    structured: null,
  };

  const payload = toOpenAiChatPayload(req);
  const tools = payload.tools as Array<{
    type: string;
    function: { name: string; description: string; parameters: unknown };
  }>;

  assertEquals(tools.length, 2);
  assertEquals(tools[0].type, 'function');
  assertEquals(tools[0].function.name, 'bareTool');
  assertEquals(tools[0].function.description, '');
  assertEquals(tools[0].function.parameters, { type: 'object', properties: {} });
  assertEquals(tools[1].type, 'function');
  assertEquals(tools[1].function.name, 'fullTool');
  assertEquals(tools[1].function.description, 'A full tool');
  assertEquals(tools[1].function.parameters, {
    type: 'object',
    properties: { x: { type: 'string' } },
  });
});

Deno.test('toOpenAiChatPayload omits tools when wireTools is empty', () => {
  const req: ProviderCompleteRequest = {
    model: 'gemini35FlashLite',
    apiId: HOST_MODELS.gemini35FlashLite.apiId,
    system: '',
    summaries: undefined,
    image: null,
    input: [{ type: 'text', text: 'go' }],
    history: [],
    thinking: 'none',
    maxOutputTokens: 1024,
    temperature: 0,
    builtins: [],
    wireTools: [],
    structured: null,
  };

  const payload = toOpenAiChatPayload(req);
  assertEquals(payload.tools, undefined);
});

Deno.test('toOpenAiChatPayload sets reasoning effort from thinking level', () => {
  const req: ProviderCompleteRequest = {
    model: 'gemini35FlashLite',
    apiId: HOST_MODELS.gemini35FlashLite.apiId,
    system: '',
    summaries: undefined,
    image: null,
    input: [{ type: 'text', text: 'go' }],
    history: [],
    thinking: 'high',
    maxOutputTokens: 2048,
    temperature: 0.7,
    builtins: [],
    wireTools: [],
    structured: null,
  };

  const payload = toOpenAiChatPayload(req);
  assertEquals(payload.reasoning, { effort: 'high' });
  assertEquals(payload.temperature, 0.7);
  assertEquals(payload.max_tokens, 2048);
  assertEquals(payload.stream, true);
});

Deno.test('toOpenAiChatPayload formats structured json_schema response_format', () => {
  registerStructured('testSchema', {
    enforced: 'responseFormat',
    jsonSchema: { type: 'object', properties: { answer: { type: 'string' } } },
  });

  const req: ProviderCompleteRequest = {
    model: 'gemini35FlashLite',
    apiId: HOST_MODELS.gemini35FlashLite.apiId,
    system: '',
    summaries: undefined,
    image: null,
    input: [{ type: 'text', text: 'go' }],
    history: [],
    thinking: 'none',
    maxOutputTokens: 1024,
    temperature: 0,
    builtins: [],
    wireTools: [],
    structured: 'testSchema',
  };

  const payload = toOpenAiChatPayload(req);
  assertEquals(payload.response_format, {
    type: 'json_schema',
    json_schema: {
      name: 'testSchema',
      strict: true,
      schema: { type: 'object', properties: { answer: { type: 'string' } } },
    },
  });
});

Deno.test('toOpenAiChatPayload omits response_format when structured has no jsonSchema', () => {
  registerStructured('noSchemaStructured', { enforced: 'prompt' });

  const req: ProviderCompleteRequest = {
    model: 'gemini35FlashLite',
    apiId: HOST_MODELS.gemini35FlashLite.apiId,
    system: '',
    summaries: undefined,
    image: null,
    input: [{ type: 'text', text: 'go' }],
    history: [],
    thinking: 'none',
    maxOutputTokens: 1024,
    temperature: 0,
    builtins: [],
    wireTools: [],
    structured: 'noSchemaStructured',
  };

  const payload = toOpenAiChatPayload(req);
  assertEquals(payload.response_format, undefined);
});

Deno.test('toOpenAiChatPayload routes web builtin to web_search_options and non-web to plugins', () => {
  const req: ProviderCompleteRequest = {
    model: 'gemini35FlashLite',
    apiId: HOST_MODELS.gemini35FlashLite.apiId,
    system: '',
    summaries: undefined,
    image: null,
    input: [{ type: 'text', text: 'search' }],
    history: [],
    thinking: 'none',
    maxOutputTokens: 1024,
    temperature: 0,
    builtins: ['googleSearch'],
    wireTools: [],
    structured: null,
  };

  const payload = toOpenAiChatPayload(req);
  assertEquals(payload.plugins, undefined);
  assertEquals(payload.web_search_options !== undefined, true);
});

Deno.test('toOpenAiChatPayload omits plugins and web_search_options when builtins have no openRouterPlugin', () => {
  const req: ProviderCompleteRequest = {
    model: 'gemini35FlashLite',
    apiId: HOST_MODELS.gemini35FlashLite.apiId,
    system: '',
    summaries: undefined,
    image: null,
    input: [{ type: 'text', text: 'go' }],
    history: [],
    thinking: 'none',
    maxOutputTokens: 1024,
    temperature: 0,
    builtins: ['unknownBuiltin'],
    wireTools: [],
    structured: null,
  };

  const payload = toOpenAiChatPayload(req);
  assertEquals(payload.plugins, undefined);
  assertEquals(payload.web_search_options, undefined);
});
