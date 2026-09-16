/**
 * Tool-result fidelity: project → history shape → adapter wire.
 */
import '../fixtures/test-host.ts';
import { assertEquals } from '@std/assert';
import { wireInteractionPart } from '../../src/kernel/interaction-parts.ts';
import {
  coerceToolResultParts,
  formatToolResult,
  projectForModel,
} from '../../src/kernel/tools/execute.ts';
import type { FunctionToolDef } from '../../src/kernel/tools/types.ts';
import { historyStep } from '../../src/providers/google/interactions/framing.ts';
import { wireMessageContent } from '../../src/providers/openrouter/openai/compat.ts';
import { toolResultMessage } from '../../src/providers/openrouter/openai/sdk-messages.ts';

const visible = { exposeToModel: true } as FunctionToolDef;

Deno.test('tool-result fidelity round-trip: project → adapters keep media parts', () => {
  const projected = projectForModel(visible, {
    finding: 'shortlist',
    candidates: [{ index: 1, caption: 'palm' }],
    parts: [
      { type: 'text', text: '1. palm' },
      { type: 'image', mimeType: 'image/jpeg', data: '/9j/abc' },
      { type: 'text', text: '2. missing preview' },
      { type: 'bogus', data: 'x' },
    ],
  });

  assertEquals(projected.parts, [
    { type: 'text', text: '1. palm' },
    { type: 'image', mimeType: 'image/jpeg', data: '/9j/abc' },
    { type: 'text', text: '2. missing preview' },
  ]);
  assertEquals((projected.data as { parts?: unknown }).parts, undefined);
  assertEquals(formatToolResult(projected).includes('/9j/abc'), false);

  const historyMsg = {
    role: 'tool' as const,
    tool_call_id: 'call_1',
    name: 'fetch_stock_media',
    content: formatToolResult(projected),
    parts: projected.parts,
  };

  assertEquals(historyStep(historyMsg), {
    type: 'function_result',
    name: 'fetch_stock_media',
    call_id: 'call_1',
    result: projected.parts?.map(wireInteractionPart),
  });

  const sdk = toolResultMessage(historyMsg);
  if (sdk.role !== 'tool') throw new Error('expected tool');
  const part = sdk.content[0];
  if (part.type !== 'tool-result') throw new Error('expected tool-result');
  assertEquals(part.output, {
    type: 'content',
    value: [
      { type: 'text', text: '1. palm' },
      {
        type: 'file',
        mediaType: 'image/jpeg',
        data: { type: 'data', data: '/9j/abc' },
      },
      { type: 'text', text: '2. missing preview' },
    ],
  });

  assertEquals(wireMessageContent(projected.parts ?? []), [
    { type: 'text', text: '1. palm' },
    {
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,/9j/abc' },
    },
    { type: 'text', text: '2. missing preview' },
  ]);
});

Deno.test('coerceToolResultParts drops empty media and unknown shapes', () => {
  assertEquals(
    coerceToolResultParts([
      { type: 'image', mimeType: 'image/png', data: '' },
      { type: 'image', mimeType: 'image/png', data: 'abc' },
    ]),
    [{ type: 'image', mimeType: 'image/png', data: 'abc' }],
  );
  assertEquals(coerceToolResultParts([]), undefined);
  assertEquals(coerceToolResultParts('nope'), undefined);
});
