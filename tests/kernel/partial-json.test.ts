import { assertEquals } from '@std/assert';
import { partialJsonObject, readJsonString } from '../../src/kernel/util/partial-json.ts';

Deno.test('partialJsonObject reads whole fields and the string being written', () => {
  assertEquals(partialJsonObject(''), {});
  assertEquals(partialJsonObject('{'), {});
  assertEquals(partialJsonObject('{"ti'), {});
  assertEquals(partialJsonObject('{"title":'), {});
  assertEquals(partialJsonObject('{"n":12,"o":{"a":[1,"}"]},"s":"x\\n\\"y'), {
    n: 12,
    o: { a: [1, '}'] },
    s: 'x\n"y',
  });
  assertEquals(partialJsonObject(' { "a" : "b" , "c" : true } '), { a: 'b', c: true });
  assertEquals(partialJsonObject('{"a":"b"}'), { a: 'b' });
  assertEquals(partialJsonObject('[1,2]'), {});
});

Deno.test('partialJsonObject leaves out a number or object still being written', () => {
  assertEquals(partialJsonObject('{"a":"b","n":12'), { a: 'b' });
  assertEquals(partialJsonObject('{"a":"b","o":{"k":1'), { a: 'b' });
  assertEquals(partialJsonObject('{"a":"b","o":{"k":"x}'), { a: 'b' });
});

Deno.test('readJsonString leaves out an escape cut off at the end', () => {
  assertEquals(readJsonString('"ab\\', 0), { text: 'ab' });
  assertEquals(readJsonString('"ab\\u00', 0), { text: 'ab' });
  assertEquals(readJsonString('"ab\\u0041', 0), { text: 'abA' });
});

Deno.test('readJsonString reads every JSON escape, and an unknown one as its letter', () => {
  assertEquals(readJsonString('"\\b\\f\\n\\r\\t\\/\\\\\\""', 0), {
    text: '\b\f\n\r\t/\\"',
    end: 18,
  });
  assertEquals(readJsonString('"a\\qb', 0), { text: 'aqb' });
  assertEquals(readJsonString('x"done" after', 1), { text: 'done', end: 7 });
});
