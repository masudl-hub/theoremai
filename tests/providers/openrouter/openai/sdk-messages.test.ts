import '../../../fixtures/test-host.ts';
import { TheorumError } from '../../../../src/guardrails/error.ts';
import { assertEquals, assertThrows } from '../../../../src/kernel/engine/assert.ts';
import { resolveTurn } from '../../../../src/kernel/registry/resolve.ts';
import type {
  InteractionPart,
  ProviderCompleteRequest,
  TurnHistoryMessage,
} from '../../../../src/kernel/types.ts';
import {
  assistantToolCallMessage,
  buildAiSdkMessages,
  contentHistoryMessage,
  historyToSdk,
  sdkContentFromOptionalParts,
  sdkContentFromParts,
  sdkPart,
  toolResultMessage,
} from '../../../../src/providers/openrouter/openai/sdk-messages.ts';

function createMockTurnRequest(profile: string, text: string): ProviderCompleteRequest {
  const { generation } = resolveTurn({ profile, input: { text } });
  return {
    model: generation.model,
    apiId: generation.apiId,
    thinking: generation.thinking,
    summaries: undefined,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system: 'Host system prompt',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
  };
}

Deno.test('sdkPart maps text parts', () => {
  const part: InteractionPart = { type: 'text', text: 'hello' };
  assertEquals(sdkPart(part), { type: 'text', text: 'hello' });
});

Deno.test('sdkPart maps image parts with data URI', () => {
  const part: InteractionPart = { type: 'image', mimeType: 'image/png', data: 'abc123' };
  assertEquals(sdkPart(part), {
    type: 'image',
    image: 'data:image/png;base64,abc123',
  });
});

Deno.test('sdkPart maps document and audio parts as file', () => {
  const doc: InteractionPart = { type: 'document', mimeType: 'application/pdf', data: 'pdfdata' };
  assertEquals(sdkPart(doc), {
    type: 'file',
    mediaType: 'application/pdf',
    data: 'pdfdata',
  });
  const audio: InteractionPart = { type: 'audio', mimeType: 'audio/wav', data: 'wavdata' };
  assertEquals(sdkPart(audio), {
    type: 'file',
    mediaType: 'audio/wav',
    data: 'wavdata',
  });
});

Deno.test('sdkContentFromParts joins text-only parts', () => {
  const parts: InteractionPart[] = [
    { type: 'text', text: 'line1' },
    { type: 'text', text: 'line2' },
  ];
  assertEquals(sdkContentFromParts(parts), 'line1\nline2');
});

Deno.test('sdkContentFromParts filters empty text parts', () => {
  const parts: InteractionPart[] = [
    { type: 'text', text: 'line1' },
    { type: 'text', text: '' },
    { type: 'text', text: 'line3' },
  ];
  assertEquals(sdkContentFromParts(parts), 'line1\nline3');
});

Deno.test('sdkContentFromParts returns array for mixed parts', () => {
  const parts: InteractionPart[] = [
    { type: 'text', text: 'caption' },
    { type: 'image', mimeType: 'image/png', data: 'img' },
  ];
  const result = sdkContentFromParts(parts);
  assertEquals(Array.isArray(result), true);
  assertEquals((result as Array<Record<string, unknown>>).length, 2);
  assertEquals((result as Array<Record<string, unknown>>)[0], { type: 'text', text: 'caption' });
  assertEquals((result as Array<Record<string, unknown>>)[1], {
    type: 'image',
    image: 'data:image/png;base64,img',
  });
});

Deno.test('toolResultMessage builds tool result message', () => {
  const msg: TurnHistoryMessage = {
    role: 'tool',
    content: 'result data',
    tool_call_id: 'call_123',
    name: 'search',
  };
  const result = toolResultMessage(msg);
  if (result.role !== 'tool') throw new Error('expected tool message');
  assertEquals(result.role, 'tool');
  const content = result.content;
  assertEquals(content.length, 1);
  const part = content[0];
  if (part.type !== 'tool-result') throw new Error('expected tool-result part');
  assertEquals(part.toolCallId, 'call_123');
  assertEquals(part.toolName, 'search');
  assertEquals(part.output, { type: 'text', value: 'result data' });
});

Deno.test('toolResultMessage prefers multimodal parts over content', () => {
  const msg: TurnHistoryMessage = {
    role: 'tool',
    content: 'text projection without bytes',
    tool_call_id: 'call_img',
    name: 'fetch_stock_media',
    parts: [
      { type: 'text', text: '1. palm' },
      { type: 'image', mimeType: 'image/jpeg', data: '/9j/abc' },
      { type: 'video', mimeType: 'video/mp4', data: 'AAAA' },
    ],
  };
  const result = toolResultMessage(msg);
  if (result.role !== 'tool') throw new Error('expected tool message');
  const part = result.content[0];
  if (part.type !== 'tool-result') throw new Error('expected tool-result part');
  assertEquals(part.output, {
    type: 'content',
    value: [
      { type: 'text', text: '1. palm' },
      {
        type: 'file',
        mediaType: 'image/jpeg',
        data: { type: 'data', data: '/9j/abc' },
      },
      {
        type: 'file',
        mediaType: 'video/mp4',
        data: { type: 'data', data: 'AAAA' },
      },
    ],
  });
});

Deno.test('toolResultMessage uses fallback IDs', () => {
  const msg: TurnHistoryMessage = { role: 'tool' };
  const result = toolResultMessage(msg);
  if (result.role !== 'tool') throw new Error('expected tool message');
  const part = result.content[0];
  if (part.type !== 'tool-result') throw new Error('expected tool-result part');
  assertEquals(part.toolCallId, 'call_tool');
  assertEquals(part.toolName, 'tool');
  assertEquals(part.output, { type: 'text', value: '' });
});

Deno.test('assistantToolCallMessage returns null without tool calls', () => {
  const msg: TurnHistoryMessage = { role: 'assistant', content: 'hi' };
  assertEquals(assistantToolCallMessage(msg), null);
  const msgEmpty: TurnHistoryMessage = { role: 'assistant', tool_calls: [] };
  assertEquals(assistantToolCallMessage(msgEmpty), null);
});

Deno.test('assistantToolCallMessage maps tool calls', () => {
  const msg: TurnHistoryMessage = {
    role: 'assistant',
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
    ],
  };
  const result = assistantToolCallMessage(msg);
  if (result?.role !== 'assistant') throw new Error('expected assistant message');
  assertEquals(result.role, 'assistant');
  const content = result.content;
  if (!Array.isArray(content)) throw new Error('expected array content');
  assertEquals(content.length, 1);
  const part = content[0];
  if (part.type !== 'tool-call') throw new Error('expected tool-call part');
  assertEquals(part.toolCallId, 'c1');
  assertEquals(part.toolName, 'search');
  assertEquals(part.input, { q: 'x' });
});

Deno.test('assistantToolCallMessage throws on invalid JSON args', () => {
  const msg: TurnHistoryMessage = {
    role: 'assistant',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fn', arguments: 'bad' } }],
  };
  assertThrows(() => assistantToolCallMessage(msg), TheorumError);
});

Deno.test('historyToSdk dispatches tool messages', () => {
  const msg: TurnHistoryMessage = { role: 'tool', content: 'ok', name: 'fn', tool_call_id: 'c1' };
  const result = historyToSdk(msg);
  if (result?.role !== 'tool') throw new Error('expected tool message');
  assertEquals(result.role, 'tool');
});

Deno.test('historyToSdk dispatches assistant with tool calls', () => {
  const msg: TurnHistoryMessage = {
    role: 'assistant',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fn', arguments: '{}' } }],
  };
  const result = historyToSdk(msg);
  if (result?.role !== 'assistant') throw new Error('expected assistant message');
  assertEquals(result.role, 'assistant');
  const content = result.content;
  if (!Array.isArray(content)) throw new Error('expected array content');
  assertEquals(content[0].type, 'tool-call');
});

Deno.test('historyToSdk dispatches content messages', () => {
  const msg: TurnHistoryMessage = { role: 'user', content: 'hello' };
  const result = historyToSdk(msg);
  if (result?.role !== 'user') throw new Error('expected user message');
  assertEquals(result.role, 'user');
  assertEquals(result.content, 'hello');
});

Deno.test('sdkContentFromOptionalParts uses text fallback when no parts', () => {
  assertEquals(sdkContentFromOptionalParts(undefined, 'fallback'), 'fallback');
  assertEquals(sdkContentFromOptionalParts([], 'fallback'), 'fallback');
  assertEquals(sdkContentFromOptionalParts(undefined, undefined), '');
});

Deno.test('sdkContentFromOptionalParts uses parts when available', () => {
  const parts: InteractionPart[] = [{ type: 'text', text: 'from parts' }];
  assertEquals(sdkContentFromOptionalParts(parts, 'fallback'), 'from parts');
});

Deno.test('contentHistoryMessage builds message with parts', () => {
  const msg: TurnHistoryMessage = {
    role: 'user',
    parts: [{ type: 'text', text: 'hello' }],
  };
  const result = contentHistoryMessage(msg);
  if (result.role !== 'user') throw new Error('expected user message');
  assertEquals(result.role, 'user');
  assertEquals(result.content, 'hello');
});

Deno.test('contentHistoryMessage builds message with content string', () => {
  const msg: TurnHistoryMessage = { role: 'assistant', content: 'hi' };
  const result = contentHistoryMessage(msg);
  if (result.role !== 'assistant') throw new Error('expected assistant message');
  assertEquals(result.role, 'assistant');
  assertEquals(result.content, 'hi');
});

Deno.test('buildAiSdkMessages includes history and input without system', () => {
  const req = createMockTurnRequest('pinned', 'test input');
  req.history = [{ role: 'user', content: 'prev' }];
  const messages = buildAiSdkMessages(req);
  assertEquals(messages.length, 2);
  const first = messages[0];
  if (first.role !== 'user') throw new Error('expected user message');
  assertEquals(first.content, 'prev');
  assertEquals(
    messages.some((m) => m.role === 'system'),
    false,
  );
});

Deno.test('buildAiSdkMessages handles empty input', () => {
  const req = createMockTurnRequest('pinned', 'x');
  req.input = [];
  req.history = [{ role: 'user', content: 'prev' }];
  const messages = buildAiSdkMessages(req);
  assertEquals(messages.length, 1);
});

Deno.test('buildAiSdkMessages handles no history', () => {
  const req = createMockTurnRequest('pinned', 'input');
  req.history = undefined;
  const messages = buildAiSdkMessages(req);
  assertEquals(messages.length, 1);
});

Deno.test('AI SDK message builder rejects media references in input and tool results', () => {
  const ref: InteractionPart = { type: 'image', mimeType: 'image/png', uri: 'files/img1' };
  assertThrows(() => sdkPart(ref), TheorumError, 'media references are not supported on openAi');
  assertThrows(
    () => sdkContentFromParts([{ type: 'text', text: 'hi' }, ref]),
    TheorumError,
    'media references are not supported on openAi',
  );
  const toolMsg: TurnHistoryMessage = {
    role: 'tool',
    tool_call_id: 'call_1',
    name: 'fetch',
    content: 'ok',
    parts: [ref],
  };
  assertThrows(
    () => toolResultMessage(toolMsg),
    TheorumError,
    'media references are not supported on openAi',
  );
});
