import { assert, assertAlmostEquals, assertEquals, assertRejects } from '@std/assert';
import {
  layoutSpace,
  layoutSpaceSoon,
  outlierThreshold,
  placeQuery,
} from '../../react/src/client/embedding-space.ts';
import {
  DOT_FLOATS,
  QUERY_SLOT,
  queryGeometry,
  SEGMENT_FLOATS,
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

Deno.test('every document sits on the unit sphere, and the axes are orthonormal', () => {
  const space = layoutSpace(Array.from({ length: 12 }, (_, i) => vector(i + 1)));
  for (const { position } of space.documents) assertAlmostEquals(Math.hypot(...position), 1, 1e-9);
  assertEquals(space.basis.axes.length, 3);
  for (const [i, a] of space.basis.axes.entries())
    for (const [j, b] of space.basis.axes.entries()) {
      const product = a.reduce((sum, v, d) => sum + v * b[d], 0);
      assertAlmostEquals(product, i === j ? 1 : 0, 1e-6);
    }
});

Deno.test('the same documents always draw the same space', () => {
  const vectors = Array.from({ length: 8 }, (_, i) => vector(i + 3));
  assertEquals(layoutSpace(vectors), layoutSpace(vectors));
});

/** Three groups of five near-duplicates, then four strangers. */
function groups(): number[][] {
  return [
    ...[vector(7), vector(8), vector(9)].flatMap((centre, g) =>
      Array.from({ length: 5 }, (_, i) => nudge(centre, 0.1, 100 + g * 10 + i)),
    ),
    ...Array.from({ length: 4 }, (_, i) => vector(i + 50)),
  ];
}

Deno.test('alike documents form a cluster each; strangers stand alone', () => {
  const space = layoutSpace(groups());
  const members = space.clusters.map((c) => c.members);
  assertEquals(members, [
    [0, 1, 2, 3, 4],
    [5, 6, 7, 8, 9],
    [10, 11, 12, 13, 14],
    [15],
    [16],
    [17],
    [18],
  ]);
  for (const document of space.documents)
    assert(space.clusters[document.cluster].members.includes(document.index));
  const [a, b] = space.documents;
  assert(distance(a.position, b.position) < distance(a.position, space.documents[5].position));
});

Deno.test('a link is exactly a pair whose cosine passes the threshold, and only inside a cluster', () => {
  const vectors = groups();
  const space = layoutSpace(vectors);
  const cosine = (i: number, j: number) =>
    vectors[i].reduce((sum, v, d) => sum + v * vectors[j][d], 0) /
    (Math.hypot(...vectors[i]) * Math.hypot(...vectors[j]));
  const pairs = vectors.flatMap((_, i) => vectors.flatMap((_, j) => (i < j ? [cosine(i, j)] : [])));
  assertAlmostEquals(space.threshold, outlierThreshold(pairs), 1e-12);
  const linked = new Set(space.links.map((l) => `${l.a}:${l.b}`));
  for (let i = 0; i < vectors.length; i += 1)
    for (let j = i + 1; j < vectors.length; j += 1)
      assertEquals(linked.has(`${i}:${j}`), cosine(i, j) > space.threshold, `${i}:${j}`);
  for (const link of space.links) {
    assertAlmostEquals(link.similarity, cosine(link.a, link.b), 1e-9);
    assertEquals(space.documents[link.a].cluster, space.documents[link.b].cluster);
  }
  assertEquals(space.links.length, 3 * 10, 'every pair inside each group of five, and no other');
});

Deno.test('the threshold is the median pair plus three robust deviations, and nothing without spread', () => {
  // Median 0.1; deviations 0, 0, 0.1, 0.1, 0.8 have median 0.1, so 0.1 + 3 × 1.4826 × 0.1.
  assertAlmostEquals(outlierThreshold([0, 0.1, 0.1, 0.2, 0.9]), 0.1 + 3 * 1.4826 * 0.1, 1e-12);
  assertEquals(outlierThreshold([0.4, 0.4, 0.4]), Infinity);
  assertEquals(outlierThreshold([]), Infinity);
  const unrelated = layoutSpace([vector(1), vector(2)]);
  assertEquals(unrelated.links, [], 'two documents have no others to stand out against');
});

Deno.test('a query lands where its own document is', () => {
  const vectors = Array.from({ length: 10 }, (_, i) => vector(i + 60));
  const space = layoutSpace(vectors);
  const landed = placeQuery(space, vectors[4]);
  assert(landed);
  assertAlmostEquals(distance(landed, space.documents[4].position), 0, 1e-6);
  assertEquals(placeQuery(space, [1, 2, 3]), null);
});

Deno.test('one, two, or identical documents still draw', () => {
  const one = layoutSpace([vector(1)]);
  assertEquals(one.documents[0].position, [0, 0, 1]);
  assertEquals(
    one.clusters.map((c) => c.members),
    [[0]],
  );
  assertEquals(spaceGeometry(one).segments.length, 0, 'a document alone is a dot, with no line');
  const two = layoutSpace([vector(1), vector(2)]);
  assertAlmostEquals(distance(two.documents[0].position, two.documents[1].position), 2, 1e-6);
  const same = layoutSpace([vector(3), vector(3), vector(3)]);
  for (const document of same.documents) assertEquals(document.position, [0, 0, 1]);
  assertEquals(same.links, [], 'no pair stands out where every pair is the same');
  assertEquals(layoutSpace([]).documents, []);
});

Deno.test('a vector of another width is placed facing, alone, and left out of the links', () => {
  const space = layoutSpace([vector(1), vector(2), [0.1, 0.2], vector(4)]);
  assertEquals(space.documents[2].position, [0, 0, 1]);
  assertEquals(space.clusters[space.documents[2].cluster].members, [2]);
  assert(space.links.every((t) => t.a !== 2 && t.b !== 2));
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

Deno.test('the geometry packs whole segments and dots, every number finite, every slot real', () => {
  const vectors = groups();
  const space = layoutSpace(vectors);
  const drawn = spaceGeometry(space);
  assertEquals(drawn.segments.length % SEGMENT_FLOATS, 0);
  assertEquals(drawn.dots.length % DOT_FLOATS, 0);
  assert(drawn.segments.every(Number.isFinite) && drawn.dots.every(Number.isFinite));
  for (let at = 0; at < drawn.segments.length; at += SEGMENT_FLOATS)
    for (const slot of [drawn.segments[at + 11], drawn.segments[at + 12]])
      assert(slot >= 0 && slot < space.documents.length);
  const dotSlots = new Set<number>();
  for (let at = 0; at < drawn.dots.length; at += DOT_FLOATS) dotSlots.add(drawn.dots[at + 9]);
  assertEquals(dotSlots.size, space.documents.length, 'a dot per document');
  for (const slot of dotSlots) assert(slot >= 0 && slot < space.documents.length);
  const landed = placeQuery(space, vectors[2]);
  assert(landed);
  const query = queryGeometry(space, landed, [{ index: 2, closeness: 1 }]);
  assertEquals(query.segments[11], QUERY_SLOT);
  assertEquals(query.segments[12], 2);
});
