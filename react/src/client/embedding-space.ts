/**
 * The index as a space: each document a point on a sphere, placed by the
 * three directions its vectors differ most along. Documents join their most
 * alike until all are linked (a maximum-similarity spanning tree); a link
 * weaker than this index's typical link is a border, and the groups it
 * leaves are clusters. Inside a cluster, each document is also linked to its
 * nearest neighbours. Positions are a projection and only approximate; every
 * link and cluster is the vectors' own cosine similarity.
 *
 * @module
 */

/** A point in the space, on the unit sphere. */
export type SpacePoint = readonly [number, number, number];

/** One document in the space. */
export type SpaceDocument = {
  /** Its index among the documents. */
  readonly index: number;
  /** Where it sits on the unit sphere. */
  readonly position: SpacePoint;
  /** The cluster it belongs to. */
  readonly cluster: number;
};

/** Documents more alike each other than the links between them. */
export type SpaceCluster = {
  /** Its documents' indexes, in order. */
  readonly members: readonly number[];
  /** Its hue, from 0 to 1 around the colour wheel: where its members' mean vector lands, as an angle around the space's two widest directions, so neighbouring clusters share a family. */
  readonly tone: number;
};

/** Two documents drawn joined, because their vectors say they are alike. */
export type SpaceLink = {
  readonly a: number;
  readonly b: number;
  /** Their cosine similarity. */
  readonly similarity: number;
};

/** The three directions the space is drawn along, kept so a query lands consistently. */
export type SpaceBasis = {
  readonly mean: Float64Array;
  /** Each a unit direction in the vectors' own space; fewer than three when the documents span fewer. */
  readonly axes: readonly Float64Array[];
};

export type EmbeddingSpace = {
  readonly documents: readonly SpaceDocument[];
  readonly clusters: readonly SpaceCluster[];
  /** The spanning tree's links, and inside each cluster each document's nearest neighbours; each pair once. */
  readonly links: readonly SpaceLink[];
  /** The weakest similarity a link inside a cluster has; the links between clusters are weaker. */
  readonly border: number;
  readonly basis: SpaceBasis;
  /** How wide the vectors are. */
  readonly dimensions: number;
};

/** Power-iteration rounds per axis; the Gram matrix is small, so this converges well inside it. */
const ROUNDS = 200;
/** Where a point lands when the projection says nothing about it. */
const FACING: SpacePoint = [0, 0, 1];
/** How many of its nearest neighbours in its cluster each document is linked to. */
const NEIGHBOURS = 3;

function dot(a: ArrayLike<number>, b: ArrayLike<number>, length: number): number {
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += a[i] * b[i];
  return sum;
}

function unit(point: readonly number[]): SpacePoint {
  const length = Math.hypot(point[0] ?? 0, point[1] ?? 0, point[2] ?? 0);
  return length < 1e-9
    ? FACING
    : [(point[0] ?? 0) / length, (point[1] ?? 0) / length, (point[2] ?? 0) / length];
}

/** The documents packed row after row, so the loops over them stay on one typed array. */
function packed(vectors: readonly (readonly number[])[], dimensions: number): Float64Array {
  const rows = new Float64Array(vectors.length * dimensions);
  vectors.forEach((vector, i) => {
    rows.set(vector, i * dimensions);
  });
  return rows;
}

/** Every document against every other: the raw dot products, once. Yields after each row, so a large index can share the thread. */
function* gramOf(rows: Float64Array, n: number, dimensions: number): Generator<void, Float64Array> {
  const gram = new Float64Array(n * n);
  const tail = dimensions - (dimensions % 4);
  for (let i = 0; i < n; i += 1) {
    const a = i * dimensions;
    for (let j = i; j < n; j += 1) {
      const b = j * dimensions;
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      // why: four running sums let the engine pipeline the multiplies; this loop is most of the layout's time.
      for (let d = 0; d < tail; d += 4) {
        s0 += rows[a + d] * rows[b + d];
        s1 += rows[a + d + 1] * rows[b + d + 1];
        s2 += rows[a + d + 2] * rows[b + d + 2];
        s3 += rows[a + d + 3] * rows[b + d + 3];
      }
      for (let d = tail; d < dimensions; d += 1) s0 += rows[a + d] * rows[b + d];
      const sum = s0 + s1 + s2 + s3;
      gram[i * n + j] = sum;
      gram[j * n + i] = sum;
    }
    yield;
  }
  return gram;
}

/** The same products about the documents' mean, from the raw ones. */
function centred(gram: Float64Array, n: number): Float64Array {
  const rows = new Float64Array(n);
  let all = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) rows[i] += gram[i * n + j];
    rows[i] /= n;
    all += rows[i];
  }
  all /= n;
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1)
    for (let j = 0; j < n; j += 1) out[i * n + j] = gram[i * n + j] - rows[i] - rows[j] + all;
  return out;
}

/** One power-iteration round: `matrix · vector`, normalised, with its length and how far it moved. */
function powerRound(
  matrix: Float64Array,
  n: number,
  vector: Float64Array,
): { next: Float64Array; length: number; moved: number } {
  const next = new Float64Array(n);
  let length = 0;
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let j = 0; j < n; j += 1) sum += matrix[i * n + j] * vector[j];
    next[i] = sum;
    length += sum * sum;
  }
  length = Math.sqrt(length);
  if (length < 1e-12) return { next: vector, length: 0, moved: 0 };
  let moved = 0;
  for (let i = 0; i < n; i += 1) {
    next[i] /= length;
    moved = Math.max(moved, Math.abs(next[i] - vector[i]));
  }
  return { next, length, moved };
}

/** Flips a vector so its largest entry is positive. */
function signed(vector: Float64Array): Float64Array {
  let lead = 0;
  for (let i = 1; i < vector.length; i += 1)
    if (Math.abs(vector[i]) > Math.abs(vector[lead])) lead = i;
  return vector[lead] < 0 ? vector.map((v) => -v) : vector;
}

/** The largest eigenvector left in a matrix, by power iteration. */
function* largestEigen(
  matrix: Float64Array,
  n: number,
  k: number,
): Generator<void, { vector: Float64Array; value: number }> {
  // invariant: a fixed start, so the same documents always draw the same space.
  let vector: Float64Array = Float64Array.from(
    { length: n },
    (_, i) => 1 + ((i * 7919 + k * 104729) % 97) / 97,
  );
  let value = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const step = powerRound(matrix, n, vector);
    if (step.length === 0) break;
    value = step.length;
    vector = step.next;
    if (step.moved < 1e-12) break;
    yield;
  }
  return { vector: signed(vector), value };
}

/** The largest eigenvectors of a symmetric matrix, by power iteration with deflation, each signed so its largest entry is positive. */
function* topEigen(
  matrix: Float64Array,
  n: number,
  count: number,
): Generator<void, { vector: Float64Array; value: number }[]> {
  const work = Float64Array.from(matrix);
  const found: { vector: Float64Array; value: number }[] = [];
  const scale = Math.max(...Array.from({ length: n }, (_, i) => Math.abs(work[i * n + i])), 0);
  for (let k = 0; k < Math.min(count, n); k += 1) {
    const { vector, value } = yield* largestEigen(work, n, k);
    if (value <= scale * 1e-9) break;
    found.push({ vector, value });
    for (let i = 0; i < n; i += 1)
      for (let j = 0; j < n; j += 1) work[i * n + j] -= value * vector[i] * vector[j];
  }
  return found;
}

function meanOf(rows: Float64Array, n: number, dimensions: number): Float64Array {
  const mean = new Float64Array(dimensions);
  for (let i = 0; i < n; i += 1)
    for (let d = 0; d < dimensions; d += 1) mean[d] += rows[i * dimensions + d];
  for (let d = 0; d < dimensions; d += 1) mean[d] /= Math.max(n, 1);
  return mean;
}

/** One axis in the vectors' own space: the documents weighted by an eigenvector of their Gram matrix. */
function axisOf(rows: Float64Array, mean: Float64Array, weights: Float64Array): Float64Array {
  const dimensions = mean.length;
  const axis = new Float64Array(dimensions);
  for (let i = 0; i < weights.length; i += 1)
    for (let d = 0; d < dimensions; d += 1)
      axis[d] += weights[i] * (rows[i * dimensions + d] - mean[d]);
  let length = 0;
  for (let d = 0; d < dimensions; d += 1) length += axis[d] * axis[d];
  length = Math.sqrt(length);
  if (length > 0) for (let d = 0; d < dimensions; d += 1) axis[d] /= length;
  return axis;
}

/** Every pair's cosine similarity, from the raw products. */
function cosineOf(gram: Float64Array, n: number): Float64Array {
  const norms = Array.from({ length: n }, (_, i) => Math.sqrt(Math.max(gram[i * n + i], 0)));
  const cosine = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1)
    for (let j = 0; j < n; j += 1)
      cosine[i * n + j] =
        norms[i] === 0 || norms[j] === 0 ? 0 : gram[i * n + j] / (norms[i] * norms[j]);
  return cosine;
}

/** The maximum-similarity spanning tree, by Prim's algorithm: each document joins the tree by its most alike document already in it. */
function* spanningTree(cosine: Float64Array, n: number): Generator<void, SpaceLink[]> {
  const joined = new Uint8Array(n);
  const best = new Float64Array(n).fill(-Infinity);
  const via = new Int32Array(n).fill(-1);
  const links: SpaceLink[] = [];
  let next = 0;
  for (let step = 0; step < n; step += 1) {
    const at = next;
    joined[at] = 1;
    if (via[at] >= 0)
      links.push({ a: Math.min(at, via[at]), b: Math.max(at, via[at]), similarity: best[at] });
    next = -1;
    for (let j = 0; j < n; j += 1) {
      if (joined[j]) continue;
      if (cosine[at * n + j] > best[j]) {
        best[j] = cosine[at * n + j];
        via[j] = at;
      }
      if (next < 0 || best[j] > best[next]) next = j;
    }
    yield;
  }
  return links;
}

/** The weakest a link may be and stay inside a cluster: a deviation below the tree's mean link. */
function borderOf(links: readonly SpaceLink[]): number {
  if (links.length === 0) return -Infinity;
  const mean = links.reduce((sum, link) => sum + link.similarity, 0) / links.length;
  const variance =
    links.reduce((sum, link) => sum + (link.similarity - mean) ** 2, 0) / links.length;
  return mean - Math.sqrt(variance);
}

/** The groups the tree's links leave once the links below the border are cut, each in document order. */
function groupsOf(n: number, links: readonly SpaceLink[], border: number): number[][] {
  const root = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (root[i] !== i) {
      root[i] = root[root[i]];
      i = root[i];
    }
    return i;
  };
  for (const link of links) if (link.similarity >= border) root[find(link.a)] = find(link.b);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const top = find(i);
    const group = groups.get(top);
    if (group) group.push(i);
    else groups.set(top, [i]);
  }
  return [...groups.values()];
}

/** Each document's nearest neighbours in its own group, by cosine, as links. */
function* neighboursOf(
  cosine: Float64Array,
  n: number,
  groups: readonly number[][],
): Generator<void, SpaceLink[]> {
  const links: SpaceLink[] = [];
  for (const group of groups)
    for (const i of group) {
      const nearest = group
        .filter((j) => j !== i)
        .sort((x, y) => cosine[i * n + y] - cosine[i * n + x] || x - y)
        .slice(0, NEIGHBOURS);
      for (const j of nearest)
        links.push({ a: Math.min(i, j), b: Math.max(i, j), similarity: cosine[i * n + j] });
      yield;
    }
  return links;
}

/** Links with each pair once, in order. */
function distinct(links: readonly SpaceLink[]): SpaceLink[] {
  const seen = new Map<string, SpaceLink>();
  for (const link of links) seen.set(`${link.a}:${link.b}`, link);
  return [...seen.values()].sort((x, y) => x.a - y.a || x.b - y.b);
}

/** The mean of some rows. */
function meanOfRows(rows: Float64Array, members: readonly number[], dimensions: number): number[] {
  const mean = new Array<number>(dimensions).fill(0);
  for (const i of members)
    for (let d = 0; d < dimensions; d += 1) mean[d] += rows[i * dimensions + d];
  return mean.map((v) => v / Math.max(members.length, 1));
}

/** A position's hue: its angle around the space's two widest directions, from 0 to 1. */
function toneOf(position: SpacePoint): number {
  return (Math.atan2(position[1], position[0]) / (2 * Math.PI) + 1) % 1;
}

/**
 * The layout, a slice at a time. Vectors whose width differs from the first
 * are placed facing the viewer, each a cluster of its own.
 */
function* layoutSteps(vectors: readonly (readonly number[])[]): Generator<void, EmbeddingSpace> {
  const dimensions = vectors[0]?.length ?? 0;
  const original = vectors.flatMap((vector, i) => (vector.length === dimensions ? [i] : []));
  const n = original.length;
  const rows = packed(
    original.map((i) => vectors[i]),
    dimensions,
  );
  const mean = meanOf(rows, n, dimensions);
  const gram = yield* gramOf(rows, n, dimensions);
  const axes = (yield* topEigen(centred(gram, n), n, 3)).map(({ vector }) =>
    axisOf(rows, mean, vector),
  );
  const basis = { mean, axes };
  const cosine = cosineOf(gram, n);
  const tree = yield* spanningTree(cosine, n);
  const border = borderOf(tree);
  const groups = groupsOf(n, tree, border);
  const clusters: SpaceCluster[] = groups.map((group) => ({
    members: group.map((i) => original[i]),
    tone: toneOf(project(basis, meanOfRows(rows, group, dimensions))),
  }));
  for (const [i, vector] of vectors.entries())
    if (vector.length !== dimensions) clusters.push({ members: [i], tone: toneOf(FACING) });
  const clusterOf = new Map(clusters.flatMap((c, k) => c.members.map((i) => [i, k] as const)));
  const documents = vectors.map(
    (vector, index): SpaceDocument => ({
      index,
      // invariant: documents and queries go through the one projection, so a query lands on its own document.
      position: vector.length === dimensions ? project(basis, vector) : FACING,
      cluster: clusterOf.get(index) ?? 0,
    }),
  );
  const links = distinct([...tree, ...(yield* neighboursOf(cosine, n, groups))]).map((link) => ({
    ...link,
    a: original[link.a],
    b: original[link.b],
  }));
  return { documents, clusters, links, border, basis, dimensions };
}

/** The space for a set of document vectors, all at once. */
export function layoutSpace(vectors: readonly (readonly number[])[]): EmbeddingSpace {
  const steps = layoutSteps(vectors);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** Time the layout works before it lets the page go on, in milliseconds. */
const SLICE_MS = 8;

/**
 * The same space, laid out in slices between which the page goes on, so a
 * large index never freezes it. Rejects with the signal's reason once aborted.
 */
export async function layoutSpaceSoon(
  vectors: readonly (readonly number[])[],
  signal?: AbortSignal,
): Promise<EmbeddingSpace> {
  const steps = layoutSteps(vectors);
  for (;;) {
    const until = performance.now() + SLICE_MS;
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
      if (performance.now() >= until) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    signal?.throwIfAborted();
  }
}

/** Where a query lands in the space: projected along the same directions as the documents. `null` when its width differs. */
export function placeQuery(space: EmbeddingSpace, query: readonly number[]): SpacePoint | null {
  if (query.length !== space.dimensions || space.dimensions === 0) return null;
  return project(space.basis, query);
}

function project(basis: SpaceBasis, vector: readonly number[]): SpacePoint {
  const offset = Array.from(vector, (v, d) => v - basis.mean[d]);
  return unit(basis.axes.map((axis) => dot(axis, offset, offset.length)));
}
