import { assertEquals } from '@std/assert';
import type { SaveRefusal } from '../server/save-wire.ts';
import { refusalLines } from '../ui/lib/refusal-lines.ts';

const refusal = (reason: SaveRefusal['reason'], detail: string[]): SaveRefusal => ({ reason, detail } as SaveRefusal);

Deno.test('a refusal with nothing more to say has no lines', () => {
  assertEquals(refusalLines(refusal('differs', [])), []);
  assertEquals(refusalLines(refusal('load', [])), []);
});

Deno.test('edits that did not load as edited are named on one line', () => {
  assertEquals(refusalLines(refusal('differs', ['bonsai.thinker', 'search_places'])), [
    'Not loading as edited: bonsai.thinker, search_places.',
  ]);
});

Deno.test("what the project said when it stopped is read a line at a time, without the blank ones", () => {
  assertEquals(refusalLines(refusal('load', ['error: Module not found\n\n    at file.ts:3:1\n', 'second report'])), [
    'error: Module not found',
    '    at file.ts:3:1',
    'second report',
  ]);
});
