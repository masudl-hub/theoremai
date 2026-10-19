/**
 * The index as a space: each document a colony on a sphere, placed by the
 * three directions its vectors differ most along, grown from its own vector,
 * and joined by threads to the documents it points most alike. Positions are
 * a projection and only approximate; the threads and their strength are the
 * vectors' own cosine similarity.
 *
 * @module
 */

/** A point in the space, on or near the unit sphere. */
export type SpacePoint = readonly [number, number, number];

/**
 * How a colony grows, read from its vector: every gene is from 0 to 1, and
 * near-identical vectors grow near-identical colonies.
 */
export type ColonyGenome = {
  /** How long each frond reaches. */
  readonly reach: readonly number[];
  /** How far each frond curls, either way from 0.5. */
  readonly curl: readonly number[];
  /** How far each frond lifts off the sphere. */
  readonly lift: readonly number[];
  /** How dense the halo of spores around it is. */
  readonly halo: number;
  /** How wide the whole colony is. */
  readonly size: number;
};

/** One document in the space. */
export type SpaceColony = {
  /** Its index among the documents. */
  readonly index: number;
  /** Where it sits on the unit sphere. */
  readonly position: SpacePoint;
  /** Where on the palette it sits, from 0 to 1: neighbours share a family. */
  readonly tone: number;
  readonly genome: ColonyGenome;
};

/** A thread between two documents that point alike. */
export type SpaceThread = {
  readonly a: number;
  readonly b: number;
  /** Their cosine similarity. */
  readonly similarity: number;
  /** How strong the thread draws, from 0 to 1, against the rest of this index. */
  readonly strength: number;
};

/** The three directions the space is drawn along, kept so a query lands consistently. */
type SpaceBasis = {
  readonly mean: Float64Array;
  /** Each a unit direction in the vectors' own space; fewer than three when the documents span fewer. */
  readonly axes: readonly Float64Array[];
};

export type EmbeddingSpace = {
  readonly colonies: readonly SpaceColony[];
  readonly threads: readonly SpaceThread[];
  readonly basis: SpaceBasis;
  /** How wide the vectors are. */
  readonly dimensions: number;
};

/** Fronds on every colony; a short one reads as absent. */
export const FRONDS = 12;
/** Threads each document reaches for, at most. */
const THREADS_EACH = 4;
/** Power-iteration rounds per axis; the Gram matrix is small, so this converges well inside it. */
const ROUNDS = 200;
/** Where a point lands when the projection says nothing about it. */
const FACING: SpacePoint = [0, 0, 1];

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
    // invariant: a fixed start, so the same documents always draw the same space.
    let vector = Float64Array.from(
      { length: n },
      (_, i) => 1 + ((i * 7919 + k * 104729) % 97) / 97,
    );
    let value = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const next = new Float64Array(n);
      let length = 0;
      for (let i = 0; i < n; i += 1) {
        let sum = 0;
        for (let j = 0; j < n; j += 1) sum += work[i * n + j] * vector[j];
        next[i] = sum;
        length += sum * sum;
      }
      length = Math.sqrt(length);
      if (length < 1e-12) break;
      let moved = 0;
      for (let i = 0; i < n; i += 1) {
        next[i] /= length;
        moved = Math.max(moved, Math.abs(next[i] - vector[i]));
      }
      value = length;
      vector = next;
      if (moved < 1e-12) break;
      yield;
    }
    if (value <= scale * 1e-9) break;
    let lead = 0;
    for (let i = 1; i < n; i += 1) if (Math.abs(vector[i]) > Math.abs(vector[lead])) lead = i;
    if (vector[lead] < 0) for (let i = 0; i < n; i += 1) vector[i] = -vector[i];
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

/** Squeezes a sum of `count` unit-scale terms to between 0 and 1. */
function gene(sum: number, count: number): number {
  return 0.5 + 0.5 * Math.tanh(sum * Math.sqrt(1 / Math.max(count, 1)) * 1.6);
}

/**
 * A colony's genome from its vector about the documents' mean (or the raw
 * vector, when there is nothing to differ from). Each gene sums an
 * interleaved band of the dimensions, so every dimension counts and close
 * vectors grow close colonies.
 */
export function genomeOf(vector: readonly number[], mean?: Float64Array): ColonyGenome {
  const dimensions = vector.length;
  const offset = mean ? Array.from(vector, (v, d) => v - (mean[d] ?? 0)) : [...vector];
  const length = Math.hypot(...offset);
  const source = length > 1e-9 ? offset : [...vector];
  const norm = Math.hypot(...source) || 1;
  const genes = FRONDS * 3 + 2;
  const sums = new Float64Array(genes);
  const counts = new Float64Array(genes);
  for (let d = 0; d < dimensions; d += 1) {
    // why: about unit length, each value is about 1/sqrt(D); scaled up it is about 1.
    sums[d % genes] += (source[d] / norm) * Math.sqrt(dimensions);
    counts[d % genes] += 1;
  }
  const at = (g: number) => gene(sums[g], counts[g]);
  return {
    reach: Array.from({ length: FRONDS }, (_, f) => at(f)),
    curl: Array.from({ length: FRONDS }, (_, f) => at(FRONDS + f)),
    lift: Array.from({ length: FRONDS }, (_, f) => at(FRONDS * 2 + f)),
    halo: at(FRONDS * 3),
    size: at(FRONDS * 3 + 1),
  };
}

/** Each document's strongest threads, both ends counted, strength measured against this index's own spread. */
function* threadsOf(gram: Float64Array, n: number): Generator<void, SpaceThread[]> {
  const norms = Array.from({ length: n }, (_, i) => Math.sqrt(Math.max(gram[i * n + i], 0)));
  const cosine = new Float64Array(n * n);
  const pairs: number[] = [];
  for (let i = 0; i < n; i += 1)
    for (let j = 0; j < n; j += 1) {
      const value = norms[i] === 0 || norms[j] === 0 ? 0 : gram[i * n + j] / (norms[i] * norms[j]);
      cosine[i * n + j] = value;
      if (j > i) pairs.push(value);
    }
  if (pairs.length === 0) return [];
  const sorted = pairs.sort((a, b) => a - b);
  const floor = sorted[Math.floor((sorted.length - 1) / 2)];
  const spread = sorted[sorted.length - 1] - floor;
  const chosen = new Map<number, SpaceThread>();
  const others = Array.from({ length: n }, (_, j) => j);
  for (let i = 0; i < n; i += 1) {
    const row = cosine.subarray(i * n, i * n + n);
    const nearest = others
      .filter((j) => j !== i)
      .sort((x, y) => row[y] - row[x])
      .slice(0, THREADS_EACH);
    for (const j of nearest) {
      const similarity = row[j];
      // invariant: below the index's median a pair is not alike, only less unlike.
      if (spread <= 1e-9 ? n > 2 : similarity <= floor) continue;
      const a = Math.min(i, j);
      const b = Math.max(i, j);
      const strength = spread <= 1e-9 ? 1 : (similarity - floor) / spread;
      chosen.set(a * n + b, { a, b, similarity, strength });
    }
    yield;
  }
  return [...chosen.values()].sort((x, y) => x.a - y.a || x.b - y.b);
}

/** A position's place on the palette: along the space's widest direction, turned a little by the next. */
function toneOf(position: SpacePoint): number {
  const along = (position[0] + 1) / 2;
  const turn = 0.08 * position[1];
  return Math.min(1, Math.max(0, along + turn));
}

/**
 * The layout, a slice at a time. Vectors whose width differs from the first
 * are left out of the threads and placed facing the viewer.
 */
function* layoutSteps(vectors: readonly (readonly number[])[]): Generator<void, EmbeddingSpace> {
  const dimensions = vectors[0]?.length ?? 0;
  const usable = vectors.map((vector) => vector.length === dimensions);
  const kept = vectors.filter((_, i) => usable[i]);
  const n = kept.length;
  const rows = packed(kept, dimensions);
  const mean = meanOf(rows, n, dimensions);
  const gram = yield* gramOf(rows, n, dimensions);
  const axes = (yield* topEigen(centred(gram, n), n, 3)).map(({ vector }) =>
    axisOf(rows, mean, vector),
  );
  const basis = { mean, axes };
  const colonies = vectors.map((vector, index): SpaceColony => {
    // invariant: documents and queries go through the one projection, so a query lands on its own document.
    const position = usable[index] ? project(basis, vector) : FACING;
    return {
      index,
      position,
      tone: toneOf(position),
      genome: genomeOf(vector, n > 1 ? mean : undefined),
    };
  });
  const original = vectors.flatMap((_, i) => (usable[i] ? [i] : []));
  const threads = (yield* threadsOf(gram, n)).map((thread) => ({
    ...thread,
    a: original[thread.a],
    b: original[thread.b],
  }));
  return { colonies, threads, basis, dimensions };
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
