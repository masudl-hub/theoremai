import { assertEquals } from '@std/assert';
import { columnCount, wallColumns } from '../../react/src/ui/wall-columns.ts';

Deno.test('as many columns fit as are at least the narrowest wide, and never none', () => {
  assertEquals(columnCount(920, 260, 12), 3);
  assertEquals(columnCount(530, 260, 12), 1);
  assertEquals(columnCount(532, 260, 12), 2);
  assertEquals(columnCount(0, 260, 12), 1);
});

Deno.test('each card goes under the shortest column so far, and unmeasured cards are dealt in turn', () => {
  // The screenshot's answers: a tall box, two short scores, a tall box, a short score, two tall.
  assertEquals(wallColumns([380, 110, 110, 400, 110, 380, 250], 3, 12), [
    [0, 6],
    [1, 3],
    [2, 4, 5],
  ]);
  assertEquals(wallColumns([undefined, undefined, undefined, undefined], 3, 12), [
    [0, 3],
    [1],
    [2],
  ]);
  assertEquals(wallColumns([], 2, 12), [[], []]);
});
