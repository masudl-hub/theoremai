import { TheoremError } from '../../../../src/guardrails/error.ts';
import { assertEquals, assertThrows } from '../../../../src/kernel/engine/assert.ts';
import { registerStructured } from '../../../../src/kernel/registry/schemas.ts';
import type { ProviderCompleteRequest } from '../../../../src/kernel/types.ts';
import {
  buildChatMessages,
  httpErrorEvent,
  openAiGatewayHeaders,
  resolveResponseFormat,
  wireTools,
} from '../../../../src/providers/openrouter/openai/compat.ts';
import { HOST_BINDINGS } from '../../../fixtures/models.ts';

function request(overrides: Partial<ProviderCompleteRequest>): ProviderCompleteRequest {
  return {
    model: 'gemini35FlashLite',
    apiId: HOST_BINDINGS.gemini35FlashLite.apiId,
    system: '',
    summaries: undefined,
    image: null,
    input: [{ type: 'text', text: 'next' }],
    history: [],
    thinking: 'none',
    maxOutputTokens: 1024,
    temperature: 0,
    builtins: [],
    wireTools: [],
    structured: null,
    ...overrides,
  };
}

Deno.test('openAiGatewayHeaders returns undefined when no site info', () => {
  assertEquals(openAiGatewayHeaders({}), undefined);
});

Deno.test('openAiGatewayHeaders sets HTTP-Referer for siteUrl', () => {
  const headers = openAiGatewayHeaders({ siteUrl: 'https://app.com' });
  assertEquals(headers?.['HTTP-Referer'], 'https://app.com');
  assertEquals(headers?.['X-Title'], undefined);
});

Deno.test('openAiGatewayHeaders sets X-Title for siteName', () => {
  const headers = openAiGatewayHeaders({ siteName: 'MyApp' });
  assertEquals(headers?.['X-Title'], 'MyApp');
  assertEquals(headers?.['HTTP-Referer'], undefined);
});

Deno.test('openAiGatewayHeaders sets both headers', () => {
  const headers = openAiGatewayHeaders({ siteUrl: 'https://a.com', siteName: 'A' });
  assertEquals(headers?.['HTTP-Referer'], 'https://a.com');
  assertEquals(headers?.['X-Title'], 'A');
});

Deno.test('httpErrorEvent carries the JSON error.message, else the raw body, else the status', async () => {
  const json = new Response('{"error":{"message":"An explicit voice is required.","code":400}}', {
    status: 400,
  });
  assertEquals(
    (await httpErrorEvent(json, 'Speech')).errorInternal,
    'Speech HTTP 400: An explicit voice is required.',
  );
  const raw = new Response('Forbidden', { status: 403 });
  assertEquals((await httpErrorEvent(raw, 'Image')).errorInternal, 'Image HTTP 403: Forbidden');
  const empty = new Response('', { status: 502 });
  assertEquals((await httpErrorEvent(empty, 'Image')).errorInternal, 'Image HTTP 502');
});

Deno.test('buildChatMessages builds system then user messages', () => {
  const messages = buildChatMessages(
    request({ system: 'Be helpful', input: [{ type: 'text', text: 'Hello' }] }),
  );
  assertEquals(messages, [
    { role: 'system', content: 'Be helpful' },
    { role: 'user', content: 'Hello' },
  ]);
});

Deno.test('buildChatMessages wires multimodal user input with image, audio, and document parts', () => {
  const messages = buildChatMessages(
    request({
      input: [
        { type: 'text', text: 'Look at this' },
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        { type: 'audio', mimeType: 'audio/wav', data: 'UklGRi===' },
        { type: 'audio', mimeType: 'audio/mp3', data: 'SUQzBA===' },
        { type: 'document', mimeType: 'application/pdf', data: 'JVBERi0=' },
      ],
    }),
  );
  assertEquals(messages.at(-1)?.content, [
    { type: 'text', text: 'Look at this' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    { type: 'input_audio', input_audio: { data: 'UklGRi===', format: 'wav' } },
    { type: 'input_audio', input_audio: { data: 'SUQzBA===', format: 'mp3' } },
    {
      type: 'file',
      file: { filename: 'document.bin', file_data: 'data:application/pdf;base64,JVBERi0=' },
    },
  ]);
});

Deno.test('buildChatMessages sends only the tool identity history carries', () => {
  const messages = buildChatMessages(request({ history: [{ role: 'tool', content: '42' }] }));
  assertEquals(messages[0], { role: 'tool', content: '42' });
});

Deno.test('buildChatMessages wires history messages with parts, tool_calls, tool results, and plain text', () => {
  const messages = buildChatMessages(
    request({
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
    }),
  );
  assertEquals(messages.slice(0, 5), [
    { role: 'user', content: 'plain text message' },
    { role: 'assistant', content: 'part A\npart B' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'calc', arguments: '{"x":1}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', name: 'calc', content: '42' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'with image' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } },
      ],
    },
  ]);
});

Deno.test('buildChatMessages wires tool results with multimodal parts', () => {
  const messages = buildChatMessages(
    request({
      history: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_media',
              type: 'function',
              function: { name: 'fetch_stock_media', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          name: 'fetch_stock_media',
          tool_call_id: 'call_media',
          content: 'shortlist',
          parts: [
            { type: 'text', text: '1. palm' },
            { type: 'image', mimeType: 'image/jpeg', data: '/9j/abc' },
            { type: 'document', mimeType: 'application/pdf', data: 'JVBERi0' },
          ],
        },
      ],
    }),
  );
  assertEquals(messages[1]?.content, [
    { type: 'text', text: 'shortlist' },
    { type: 'text', text: '1. palm' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/abc' } },
    {
      type: 'file',
      file: { filename: 'document.bin', file_data: 'data:application/pdf;base64,JVBERi0' },
    },
  ]);
});

Deno.test('buildChatMessages joins text-only history content and parts into one string', () => {
  const messages = buildChatMessages(
    request({
      input: [],
      history: [{ role: 'user', content: 'first', parts: [{ type: 'text', text: 'second' }] }],
    }),
  );
  assertEquals(messages, [{ role: 'user', content: 'first\nsecond' }]);
});

Deno.test('buildChatMessages rejects media references (openAi compat carries inline bytes only)', () => {
  const req = request({
    input: [
      { type: 'text', text: 'Describe' },
      { type: 'video', mimeType: 'video/mp4', uri: 'files/abc123' },
    ],
  });
  assertThrows(
    () => buildChatMessages(req),
    TheoremError,
    'media references are not supported on openAi',
  );
});

Deno.test('wireTools formats tools with name, description, and parameters; empty is undefined', () => {
  assertEquals(wireTools([]), undefined);
  assertEquals(
    wireTools([
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
    ]),
    [
      {
        type: 'function',
        function: {
          name: 'bareTool',
          description: '',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: {
          name: 'fullTool',
          description: 'A full tool',
          parameters: { type: 'object', properties: { x: { type: 'string' } } },
        },
      },
    ],
  );
});

Deno.test('resolveResponseFormat formats json_schema, and is undefined without a structured id', () => {
  registerStructured('compatSchema', {
    jsonSchema: { type: 'object', properties: { answer: { type: 'string' } } },
  });
  assertEquals(resolveResponseFormat('compatSchema'), {
    type: 'json_schema',
    json_schema: {
      name: 'compatSchema',
      strict: true,
      schema: { type: 'object', properties: { answer: { type: 'string' } } },
    },
  });
  assertEquals(resolveResponseFormat(null), undefined);
});
