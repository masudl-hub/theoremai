import { assertEquals } from '@std/assert';
import { lineDiff } from '../../studio/line-diff.ts';

const text = (was: string, now: string) => lineDiff(was, now).map((line) => `${line.sign}${line.text}`);

Deno.test('lineDiff: one line changed is taken out, then put in', () => {
  assertEquals(text('gemini-2.5-flash', 'gemini-2.5-pro'), ['-gemini-2.5-flash', '+gemini-2.5-pro']);
});

Deno.test('lineDiff: the lines both hold stay as context around the change', () => {
  assertEquals(text('{\n  "a": 1,\n  "b": 2\n}', '{\n  "a": 1,\n  "b": 3,\n  "c": 4\n}'), [
    ' {',
    '   "a": 1,',
    '-  "b": 2',
    '+  "b": 3,',
    '+  "c": 4',
    ' }',
  ]);
});

Deno.test('lineDiff: the same text is all shared', () => {
  assertEquals(text('a\nb', 'a\nb'), [' a', ' b']);
});

Deno.test('lineDiff: a line taken from the middle leaves the rest shared', () => {
  assertEquals(text('a\nb\nc', 'a\nc'), [' a', '-b', ' c']);
});
