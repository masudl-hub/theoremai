/**
 * The index as a space: each document a point in a ball, placed by the
 * three directions its vectors differ most along, each measured in its own
 * spread so the space is as deep as it is wide. Its direction from the
 * centre is its direction along those three; its distance is how far it sits
 * from the index's mean along them, as `r / (r + median)`, scaled so the
 * farthest document is on the rim: the order of distances is kept, and no
 * one far document squeezes the rest into the centre. A pair is alike when
 * its cosine similarity stands out against every other pair in the index:
 * more than {@link OUTLIER} robust deviations above the median pair. Most
 * pairs in an index are unrelated, so the median and its deviation say what
 * unrelated looks like for this model and these documents. Each document is
 * linked to its nearest neighbour, the one its cosine similarity is highest
 * with, when that pair is alike. A cluster is documents alike pairs connect,
 * directly or through each other. Positions are a projection and only
 * approximate; links and clusters are the vectors' own cosine similarity.
 *
 * @module
 */

/** A point in the space, inside the unit ball. */
export type SpacePoint = readonly [number, number, number];

/** One document in the space. */
export type SpaceDocument = {
  /** Its index among the documents. */
  readonly index: number;
  /** Where it sits in the unit ball. */
  readonly position: SpacePoint;
  /** The cluster it belongs to. */
  readonly cluster: number;
};

/** Documents alike pairs connect, directly or through each other. */
export type SpaceCluster = {
  /** Its documents' indexes, in order. */
  readonly members: readonly number[];
  /** Its hue, from 0 to 1 around the colour wheel: where its members' mean vector lands, as an angle around the space's two widest directions, so neighbouring clusters share a family. */
  readonly tone: number;
};

/** A document and its nearest neighbour, whose cosine similarity is above the space's threshold. */
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
  /** Each axis's spread over the documents; a point is measured along each in its own spread, so the space is as deep as it is wide. */
  readonly spreads: readonly number[];
  /** The documents' median distance from the mean, so measured. */
  readonly scale: number;
  /** The farthest document's `r / (r + scale)`; dividing by it puts that document on the rim. */
  readonly reach: number;
};

export type EmbeddingSpace = {
  readonly documents: readonly SpaceDocument[];
  readonly clusters: readonly SpaceCluster[];
  /** Each document's nearest neighbour, where that pair is above the threshold; a pair that is each other's nearest appears once. */
  readonly links: readonly SpaceLink[];
  /** The cosine similarity a pair must pass to be linked; `Infinity` when the index has too few pairs, or too alike, to say what unrelated looks like. */
  readonly threshold: number;
  readonly basis: SpaceBasis;
  /** How wide the vectors are. */
  readonly dimensions: number;
};

/** Power-iteration rounds per axis; the Gram matrix is small, so this converges well inside it. */
const ROUNDS = 200;
/** Where a point lands when the projection says nothing about it. */
const CENTRE: SpacePoint = [0, 0, 0];
/** How many robust deviations above the median pair a pair must be to count as alike: the usual cut for an outlier. */
const OUTLIER = 3;
/** Scales the median absolute deviation to a standard deviation, for normally spread values. */
const MAD_SCALE = 1.4826;

function dot(a: ArrayLike<number>, b: ArrayLike<number>, length: number): number {
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += a[i] * b[i];
  return sum;
}

/** A point's offset from the mean along each axis, in that axis's own spread; 0 along an axis with none. */
function along(
  axes: readonly Float64Array[],
  mean: Float64Array,
  spreads: readonly number[],
  vector: ArrayLike<number>,
): number[] {
  const offset = Array.from(vector, (v, d) => v - mean[d]);
  return [0, 1, 2].map((k) =>
    axes[k] && spreads[k] > 1e-12 ? dot(axes[k], offset, offset.length) / spreads[k] : 0,
  );
}

/** Each axis's spread: the root mean square of the documents' offsets along it. */
function spreadsOf(
  axes: readonly Float64Array[],
  mean: Float64Array,
  vectors: readonly (readonly number[])[],
): number[] {
  return [0, 1, 2].map((k) => {
    const axis = axes[k];
    if (!axis || vectors.length === 0) return 0;
    const squares = vectors.reduce((sum, v) => {
      const at = dot(
        axis,
        Array.from(v, (x, d) => x - mean[d]),
        v.length,
      );
      return sum + at * at;
    }, 0);
    return Math.sqrt(squares / vectors.length);
  });
}

/** Coordinates in the axes, drawn into the ball: same direction, distance `r / (r + scale) / reach`. */
function inBall(point: readonly number[], scale: number, reach: number): SpacePoint {
  const length = Math.hypot(point[0], point[1], point[2]);
  if (length < 1e-9 || scale <= 0 || reach <= 0) return CENTRE;
  const radius = length / (length + scale) / reach / length;
  return [point[0] * radius, point[1] * radius, point[2] * radius];
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

/** The median of some values; it sorts them. */
function medianOf(values: Float64Array): number {
  values.sort();
  const middle = values.length >> 1;
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

/**
 * The similarity one must pass to stand out among `similarities`: their
 * median plus {@link OUTLIER} robust deviations. `Infinity` when they have no
 * spread, since then nothing stands out.
 */
export function outlierThreshold(similarities: ArrayLike<number>): number {
  const values = Float64Array.from(similarities);
  if (values.length === 0) return Infinity;
  const median = medianOf(values.slice());
  const deviation = MAD_SCALE * medianOf(values.map((v) => Math.abs(v - median)));
  return deviation > 0 ? median + OUTLIER * deviation : Infinity;
}

/** Every pair's similarity, once each. */
function pairsOf(cosine: Float64Array, n: number): Float64Array {
  const pairs = new Float64Array((n * (n - 1)) / 2);
  let at = 0;
  for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) pairs[at++] = cosine[i * n + j];
  return pairs;
}

/** Every pair above the threshold, a row at a time: what clusters are made of. */
function* linksOf(
  cosine: Float64Array,
  n: number,
  threshold: number,
): Generator<void, SpaceLink[]> {
  const links: SpaceLink[] = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1)
      if (cosine[i * n + j] > threshold) links.push({ a: i, b: j, similarity: cosine[i * n + j] });
    yield;
  }
  return links;
}

/** The document whose cosine similarity with `i` is highest, the first on a tie; -1 when there is no other. */
function nearestTo(cosine: Float64Array, n: number, i: number): number {
  let best = -1;
  for (let j = 0; j < n; j += 1)
    if (j !== i && (best < 0 || cosine[i * n + j] > cosine[i * n + best])) best = j;
  return best;
}

/** Each document's nearest neighbour where that pair passes the threshold, each pair once, a row at a time. */
function* nearestOf(
  cosine: Float64Array,
  n: number,
  threshold: number,
): Generator<void, SpaceLink[]> {
  const seen = new Set<number>();
  const links: SpaceLink[] = [];
  for (let i = 0; i < n; i += 1) {
    const best = nearestTo(cosine, n, i);
    const [a, b] = i < best ? [i, best] : [best, i];
    if (best >= 0 && cosine[i * n + best] > threshold && !seen.has(a * n + b)) {
      seen.add(a * n + b);
      links.push({ a, b, similarity: cosine[i * n + best] });
    }
    yield;
  }
  return links.sort((x, y) => x.a - y.a || x.b - y.b);
}

/** The groups the links connect, each in document order. */
function groupsOf(n: number, links: readonly SpaceLink[]): number[][] {
  const root = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (root[i] !== i) {
      root[i] = root[root[i]];
      i = root[i];
    }
    return i;
  };
  for (const link of links) root[find(link.a)] = find(link.b);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const top = find(i);
    const group = groups.get(top);
    if (group) group.push(i);
    else groups.set(top, [i]);
  }
  return [...groups.values()];
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
 * are placed at the centre, each a cluster of its own.
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
  const kept = original.map((i) => vectors[i]);
  const spreads = spreadsOf(axes, mean, kept);
  const coordinates = kept.map((vector) => along(axes, mean, spreads, vector));
  const lengths = Float64Array.from(coordinates, (p) => Math.hypot(p[0], p[1], p[2]));
  // why: when more than half sit at the mean, the farthest sets the scale, so the rest still spread out.
  const median = n > 0 ? medianOf(lengths.slice()) : 0;
  const scale = median > 1e-9 ? median : lengths.reduce((most, v) => Math.max(most, v), 0);
  const reach = lengths.reduce((most, r) => Math.max(most, scale > 0 ? r / (r + scale) : 0), 0);
  const basis = { mean, axes, spreads, scale, reach };
  const cosine = cosineOf(gram, n);
  const threshold = outlierThreshold(pairsOf(cosine, n));
  const found = yield* linksOf(cosine, n, threshold);
  const groups = groupsOf(n, found);
  const nearest = yield* nearestOf(cosine, n, threshold);
  const clusters: SpaceCluster[] = groups.map((group) => ({
    members: group.map((i) => original[i]),
    tone: toneOf(project(basis, meanOfRows(rows, group, dimensions))),
  }));
  for (const [i, vector] of vectors.entries())
    if (vector.length !== dimensions) clusters.push({ members: [i], tone: toneOf(CENTRE) });
  const clusterOf = new Map(clusters.flatMap((c, k) => c.members.map((i) => [i, k] as const)));
  const documents = vectors.map(
    (vector, index): SpaceDocument => ({
      index,
      // invariant: documents and queries go through the one projection, so a query lands on its own document.
      position: vector.length === dimensions ? project(basis, vector) : CENTRE,
      cluster: clusterOf.get(index) ?? 0,
    }),
  );
  const links = nearest.map((link) => ({ ...link, a: original[link.a], b: original[link.b] }));
  return { documents, clusters, links, threshold, basis, dimensions };
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

function project(basis: SpaceBasis, vector: ArrayLike<number>): SpacePoint {
  return inBall(along(basis.axes, basis.mean, basis.spreads, vector), basis.scale, basis.reach);
}
