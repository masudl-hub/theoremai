import { assertEquals } from '@std/assert';
import { entriesOf, entriesText } from '../ui/lib/entries.ts';

const shown = (text: string, typed: boolean) =>
  entriesOf(text, typed).map(({ name, value }) => [name, value]);
const row = (name: string, value: string) => ({ key: name, name, value });

Deno.test('text that is no JSON object has no rows', () => {
  assertEquals(shown('', false), []);
  assertEquals(shown('{', false), []);
  assertEquals(shown('[1]', false), []);
});

Deno.test('text values stay text, whatever they read as', () => {
  assertEquals(shown('{"Accept":"application/json","X-Count":"3"}', false), [
    ['Accept', 'application/json'],
    ['X-Count', '3'],
  ]);
  assertEquals(entriesText([row('X-Count', '3')], false), '{"X-Count":"3"}');
});

Deno.test('typed values keep their type, and a string that reads as JSON keeps its quotes', () => {
  const text = '{"service.name":"desk","port":8080,"on":true,"build":"7"}';
  const rows = entriesOf(text, true);
  assertEquals(
    rows.map(({ value }) => value),
    ['desk', '8080', 'true', '"7"'],
  );
  assertEquals(entriesText(rows, true), text);
});

Deno.test('rows with no name are left out, and none named is blank', () => {
  assertEquals(entriesText([row('', 'alone'), row(' X-Id ', 'a')], false), '{"X-Id":"a"}');
  assertEquals(entriesText([row('', 'alone')], false), '');
});
