import { TheoremError } from '../../../src/guardrails/error.ts';
import { assertEquals, assertThrows } from '../../../src/kernel/engine/assert.ts';
import {
  historyToolArguments,
  parseToolArgumentsObject,
} from '../../../src/providers/shared/tool-args.ts';

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
