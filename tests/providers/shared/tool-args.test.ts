import { TheoremError } from '../../../src/guardrails/error.ts';
import { assertEquals, assertThrows } from '../../../src/kernel/engine/assert.ts';
import type { ProviderEvent, ToolFailure } from '../../../src/kernel/types.ts';
import {
  historyToolArguments,
  parseToolArgumentsObject,
  toolCallEvents,
} from '../../../src/providers/shared/tool-args.ts';

/** The call id each event carries, and the failure a malformed call settled with. */
function callIds(events: readonly ProviderEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'tool' ? [event.tool.callId] : []));
}

function failureIn(events: readonly ProviderEvent[]): ToolFailure | undefined {
  const last = events.at(-1);
  return last?.type === 'tool' && last.tool.phase === 'error' ? last.tool.failure : undefined;
}

Deno.test('parseToolArgumentsObject reads JSON objects and no-argument calls', () => {
  assertEquals(parseToolArgumentsObject('{"a":1}'), { ok: true, value: { a: 1 } });
  assertEquals(parseToolArgumentsObject({ a: 1 }), { ok: true, value: { a: 1 } });
  assertEquals(parseToolArgumentsObject(''), { ok: true, value: {} });
  assertEquals(parseToolArgumentsObject('   '), { ok: true, value: {} });
  assertEquals(parseToolArgumentsObject(undefined), { ok: true, value: {} });
  assertEquals(parseToolArgumentsObject(null), { ok: true, value: {} });
});

Deno.test('parseToolArgumentsObject fails on malformed or non-object arguments', () => {
  assertEquals(parseToolArgumentsObject('not json').ok, false);
  assertEquals(parseToolArgumentsObject('[1]').ok, false);
  assertEquals(parseToolArgumentsObject('"text"').ok, false);
  assertEquals(parseToolArgumentsObject(7).ok, false);
  assertEquals(parseToolArgumentsObject('null').ok, false);
  assertEquals(parseToolArgumentsObject('42').ok, false);
  assertEquals(parseToolArgumentsObject('true').ok, false);
  assertEquals(parseToolArgumentsObject('{"a":').ok, false);
  assertEquals(parseToolArgumentsObject('"{\\"a\\":1}"').ok, false);
  assertEquals(parseToolArgumentsObject([1]).ok, false);
});

Deno.test('historyToolArguments throws TheoremError instead of inventing arguments', () => {
  assertEquals(historyToolArguments('{"a":1}'), { a: 1 });
  assertThrows(() => historyToolArguments('not json'), TheoremError);
  assertThrows(() => historyToolArguments('[1]'), TheoremError);
});

Deno.test('toolCallEvents emits the call, never inventing arguments', () => {
  assertEquals(toolCallEvents({ id: 'c1', name: 't' }, '{"a":1}'), [
    { type: 'tool', tool: { name: 't', callId: 'c1', arguments: { a: 1 } } },
  ]);

  const malformed = toolCallEvents({ id: 'c1', name: 't' }, '{bad');
  assertEquals(malformed[0], { type: 'tool', tool: { name: 't', callId: 'c1', arguments: {} } });
  assertEquals(callIds(malformed), ['c1', 'c1']);
  assertEquals(failureIn(malformed)?.code, 'malformed_arguments');
  assertEquals(failureIn(malformed)?.kind, 'bad_response');
  assertEquals(failureIn(malformed)?.details, { raw: '{bad' });
});

Deno.test('toolCallEvents fails a nameless call and joins an id-less one', () => {
  const nameless = toolCallEvents({ id: 'c1', name: '  ' }, '{}');
  assertEquals(failureIn(nameless)?.message, 'function call is missing a name');

  const idless = toolCallEvents({ name: 't' }, '{bad');
  const [minted, again] = callIds(idless);
  assertEquals(minted?.startsWith('call_t_'), true);
  assertEquals(again, minted);
});
