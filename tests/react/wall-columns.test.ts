import { assertEquals } from '@std/assert';
import { columnCount, wallPlaces } from '../../react/src/ui/wall-columns.ts';

Deno.test('as many columns fit as are at least the narrowest wide, and never none', () => {
  assertEquals(columnCount(920, 260, 12), 3);
  assertEquals(columnCount(530, 260, 12), 1);
  assertEquals(columnCount(532, 260, 12), 2);
  assertEquals(columnCount(0, 260, 12), 1);
});

const columns = (placed: ReturnType<typeof wallPlaces>) =>
  placed.places.map((place) => place.column);

Deno.test('each card goes under the shortest column so far, and unmeasured cards are dealt in turn', () => {
  // The screenshot's answers: a tall box, two short scores, a tall box, a short score, two tall.
  const answers = wallPlaces([380, 110, 110, 400, 110, 380, 250], 3, 12);
  assertEquals(columns(answers), [0, 1, 2, 1, 2, 2, 0]);
  assertEquals(answers.places[5], { column: 2, top: 244 });
  assertEquals(answers.height, 642);
  assertEquals(
    columns(wallPlaces([undefined, undefined, undefined, undefined], 3, 12)),
    [0, 1, 2, 0],
  );
  assertEquals(wallPlaces([], 2, 12), { places: [], height: 0 });
});

Deno.test('a card that renders nothing takes no place and no gap', () => {
  const placed = wallPlaces([100, 0, 100, 0], 2, 12);
  assertEquals(columns(placed), [0, 1, 1, 0]);
  assertEquals(placed.places[2], { column: 1, top: 0 });
  assertEquals(placed.height, 100);
});
