import { assert, assertAlmostEquals, assertEquals, assertRejects } from '@std/assert';
import {
  FRONDS,
  genomeOf,
  layoutSpace,
  layoutSpaceSoon,
  placeQuery,
} from '../../react/src/client/embedding-space.ts';
import {
  QUERY_COLONY,
  queryGeometry,
  SEGMENT_FLOATS,
  SPORE_FLOATS,
  spaceGeometry,
} from '../../react/src/client/space-geometry.ts';

/** A seeded vector of the given width, about unit length. */
function vector(seed: number, dimensions = 64): number[] {
  let state = seed * 2654435761;
  const values = Array.from({ length: dimensions }, () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648 - 0.5;
  });
  const length = Math.hypot(...values);
  return values.map((v) => v / length);
}

function nudge(values: readonly number[], by: number, seed: number): number[] {
  const noise = vector(seed, values.length);
  return values.map((v, i) => v + by * noise[i]);
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

Deno.test('every colony sits on the unit sphere, and the axes are orthonormal', () => {
  const space = layoutSpace(Array.from({ length: 12 }, (_, i) => vector(i + 1)));
  for (const colony of space.colonies) assertAlmostEquals(Math.hypot(...colony.position), 1, 1e-9);
  assertEquals(space.basis.axes.length, 3);
  for (const [i, a] of space.basis.axes.entries())
    for (const [j, b] of space.basis.axes.entries()) {
      const product = a.reduce((sum, v, d) => sum + v * b[d], 0);
      assertAlmostEquals(product, i === j ? 1 : 0, 1e-6);
    }
});

Deno.test('the same documents always draw the same space', () => {
  const vectors = Array.from({ length: 8 }, (_, i) => vector(i + 3));
  assertEquals(layoutSpace(vectors).colonies, layoutSpace(vectors).colonies);
});

Deno.test('near-duplicates sit together and grow alike; strangers do not', () => {
  const base = vector(7);
  const vectors = [
    base,
    nudge(base, 0.02, 99),
    ...Array.from({ length: 8 }, (_, i) => vector(i + 20)),
  ];
  const space = layoutSpace(vectors);
  const [a, b, c] = space.colonies;
  assert(distance(a.position, b.position) < distance(a.position, c.position));
  const reach = (i: number) => space.colonies[i].genome.reach;
  const gap = (x: readonly number[], y: readonly number[]) =>
    Math.max(...x.map((v, i) => Math.abs(v - y[i])));
  assert(gap(reach(0), reach(1)) < 0.1, 'near-duplicates grow alike');
  assert(gap(reach(0), reach(2)) > 0.1, 'strangers grow apart');
});

Deno.test('a genome has every gene between 0 and 1', () => {
  const genome = genomeOf(vector(5, 3072));
  assertEquals(genome.reach.length, FRONDS);
  for (const value of [...genome.reach, ...genome.curl, ...genome.lift, genome.halo, genome.size])
    assert(value >= 0 && value <= 1);
});

Deno.test('threads join each document to its most alike, once each, never below the median', () => {
  const base = vector(11);
  const vectors = [
    base,
    nudge(base, 0.05, 1),
    ...Array.from({ length: 6 }, (_, i) => vector(i + 40)),
  ];
  const space = layoutSpace(vectors);
  const keys = space.threads.map((t) => `${t.a}:${t.b}`);
  assertEquals(new Set(keys).size, keys.length);
  for (const thread of space.threads) {
    assert(thread.a < thread.b);
    assert(thread.strength > 0 && thread.strength <= 1);
  }
  const strongest = space.threads.reduce((x, y) => (y.strength > x.strength ? y : x));
  assertEquals([strongest.a, strongest.b], [0, 1]);
  assertEquals(strongest.strength, 1);
});

Deno.test('a query lands where its own document is', () => {
  const vectors = Array.from({ length: 10 }, (_, i) => vector(i + 60));
  const space = layoutSpace(vectors);
  const landed = placeQuery(space, vectors[4]);
  assert(landed);
  assertAlmostEquals(distance(landed, space.colonies[4].position), 0, 1e-6);
  assertEquals(placeQuery(space, [1, 2, 3]), null);
});

Deno.test('one, two, or identical documents still draw', () => {
  const one = layoutSpace([vector(1)]);
  assertEquals(one.colonies[0].position, [0, 0, 1]);
  assertEquals(one.threads, []);
  const two = layoutSpace([vector(1), vector(2)]);
  assertAlmostEquals(distance(two.colonies[0].position, two.colonies[1].position), 2, 1e-6);
  assertEquals(two.threads.length, 1);
  const same = layoutSpace([vector(3), vector(3), vector(3)]);
  for (const colony of same.colonies) assertEquals(colony.position, [0, 0, 1]);
  assertEquals(layoutSpace([]).colonies, []);
});

Deno.test('a vector of another width is placed facing, and left out of the threads', () => {
  const space = layoutSpace([vector(1), vector(2), [0.1, 0.2], vector(4)]);
  assertEquals(space.colonies[2].position, [0, 0, 1]);
  assert(space.threads.every((t) => t.a !== 2 && t.b !== 2));
});

Deno.test('laid out in slices, the space is the same as all at once', async () => {
  const vectors = Array.from({ length: 30 }, (_, i) => vector(i + 80, 256));
  assertEquals(await layoutSpaceSoon(vectors), layoutSpace(vectors));
  const stopped = new AbortController();
  stopped.abort();
  await assertRejects(() =>
    layoutSpaceSoon(
      Array.from({ length: 400 }, (_, i) => vector(i, 3072)),
      stopped.signal,
    ),
  );
});

Deno.test('the geometry packs whole segments and spores, every number finite, every colony real', () => {
  const vectors = Array.from({ length: 9 }, (_, i) => vector(i + 100, 128));
  const space = layoutSpace(vectors);
  const drawn = spaceGeometry(space);
  assertEquals(drawn.segments.length % SEGMENT_FLOATS, 0);
  assertEquals(drawn.spores.length % SPORE_FLOATS, 0);
  assert(drawn.segments.every(Number.isFinite) && drawn.spores.every(Number.isFinite));
  for (let at = 0; at < drawn.segments.length; at += SEGMENT_FLOATS)
    for (const colony of [drawn.segments[at + 11], drawn.segments[at + 12]])
      assert(colony >= 0 && colony < 9);
  const landed = placeQuery(space, vectors[2]);
  assert(landed);
  const query = queryGeometry(space, landed, [{ index: 2, closeness: 1 }]);
  assertEquals(query.segments[11], QUERY_COLONY);
  assertEquals(query.segments[12], 2);
});
