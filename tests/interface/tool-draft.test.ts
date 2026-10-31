import { assertEquals } from '@std/assert';
import { argumentsSoFar, foldTurnEvents, toolCallsOf } from '../../src/interface/mod.ts';
import type { ToolBlock } from '../../src/interface/types.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';

const draft = (text: string, callId = 'call_1', name = 'write_app'): TurnEvent => ({
  type: 'tool_draft',
  callId,
  name,
  text,
});

/** The one value `values` holds. */
function only<T>(values: readonly T[]): T {
  assertEquals(values.length, 1);
  return values[0] as T;
}

function toolBlocks(events: TurnEvent[]): ToolBlock[] {
  return foldTurnEvents(events).filter((block): block is ToolBlock => block.kind === 'tool');
}

Deno.test('a draft folds into a call the whole call replaces where it stood', () => {
  const events: TurnEvent[] = [
    draft('{"title":"Hi",'),
    draft('"app_tsx":"impo'),
    { type: 'text', text: 'Writing it.' },
  ];
  const drafted = only(toolBlocks(events));
  assertEquals(drafted.id, 'tool-call_1');
  assertEquals(drafted.tool.draft, '{"title":"Hi","app_tsx":"impo');
  assertEquals(argumentsSoFar(drafted.tool), { title: 'Hi', app_tsx: 'impo' });

  const whole: TurnEvent = {
    type: 'tool',
    tool: {
      name: 'write_app',
      callId: 'call_1',
      operationId: 'op_1',
      arguments: { title: 'Hi', app_tsx: 'import x' },
    },
  };
  assertEquals(
    foldTurnEvents([...events, whole]).map((block) => block.kind),
    ['tool', 'text'],
  );
  const call = only(toolBlocks([...events, whole]));
  assertEquals(call.id, 'tool-op_1');
  assertEquals(call.tool.draft, undefined);
  assertEquals(argumentsSoFar(call.tool), { title: 'Hi', app_tsx: 'import x' });

  const calls = toolCallsOf([...events, whole]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.arguments, { title: 'Hi', app_tsx: 'import x' });
});

Deno.test('a draft left when the turn ends stays a draft', () => {
  const call = only(toolCallsOf([draft('{"app_tsx":"a')]));
  assertEquals(call.state, undefined);
  assertEquals(argumentsSoFar(call), { app_tsx: 'a' });
});

Deno.test('a draft takes the name of its latest piece', () => {
  const call = only(
    toolCallsOf([draft('{"a":', 'call_1', 'write'), draft('1}', 'call_1', 'write_app')]),
  );
  assertEquals(call.name, 'write_app');
  assertEquals(call.draft, '{"a":1}');
});

Deno.test('parallel drafts keep their order once whole', () => {
  const events: TurnEvent[] = [
    draft('{"a":1}', 'c1'),
    draft('{"a":2}', 'c2'),
    {
      type: 'tool',
      tool: { name: 'write_app', callId: 'c1', operationId: 'o1', arguments: { a: 1 } },
    },
    {
      type: 'tool',
      tool: { name: 'write_app', callId: 'c2', operationId: 'o2', arguments: { a: 2 } },
    },
  ];
  assertEquals(
    toolCallsOf(events).map((call) => call.callId),
    ['c1', 'c2'],
  );
  assertEquals(
    toolBlocks(events).map((block) => block.id),
    ['tool-o1', 'tool-o2'],
  );
});

Deno.test('the media a tool returns stands where the call ran, before what comes next', () => {
  const tool = { name: 'draw', callId: 'call_1', arguments: {}, at: 1 };
  const parts = [
    { type: 'text' as const, text: 'Not shown.' },
    { type: 'image' as const, mimeType: 'image/png', data: 'AAAA' },
    { type: 'image' as const, mimeType: 'image/png', uri: 'gs://bucket/two.png' },
  ];
  const blocks = foldTurnEvents([
    { type: 'text', text: 'Drawing.' },
    { type: 'tool', tool },
    { type: 'tool', tool: { ...tool, phase: 'complete', output: {}, parts } },
    { type: 'text', text: 'There it is.' },
  ] as TurnEvent[]);
  assertEquals(
    blocks.map((block) => block.kind),
    ['text', 'tool', 'media', 'media', 'text'],
  );
  const media = blocks.filter((block) => block.kind === 'media');
  assertEquals(
    media.map((block) => block.data ?? block.url),
    ['AAAA', 'gs://bucket/two.png'],
  );
});
