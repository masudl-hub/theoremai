/**
 * What the embedding space draws, as flat arrays a GPU takes as they are:
 * every colony's fronds, spores and halo grown from its genome, the threads
 * between alike documents along the sphere, and a query's spore with a
 * thread to each match.
 *
 * @module
 */

import {
  type EmbeddingSpace,
  FRONDS,
  type SpaceColony,
  type SpacePoint,
} from './embedding-space.ts';

/** Floats per line segment: from (3), to (3), colour (3), alpha, width, the two colonies it belongs to, and where it sits along its stroke (0 at the root, 1 at the tip). */
export const SEGMENT_FLOATS = 14;
/** Floats per spore: position (3), colour (3), alpha, size, its colony, and where it sits along its stroke. */
export const SPORE_FLOATS = 10;
/** Stands for the query where a colony's index would go. */
export const QUERY_COLONY = -1;

/**
 * The space's palette, cool to warm: deep teal, cyan, chartreuse, amber, coral.
 * A colony's tone picks its place; its fronds warm toward their tips.
 */
const PALETTE: readonly (readonly [number, number, number])[] = [
  '#12b5a8',
  '#3fd8f2',
  '#c6f23a',
  '#ffb43b',
  '#ff6f5e',
].map(
  (hex) =>
    [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as [
      number,
      number,
      number,
    ],
);
/** The query's spore: near white, faintly cool, so it reads apart from every colony. */
const QUERY_COLOUR: readonly [number, number, number] = [0.93, 0.97, 1.0];

/** A colour on the palette, from 0 (teal) to 1 (coral). */
function paletteAt(tone: number): readonly [number, number, number] {
  const at = Math.min(1, Math.max(0, tone)) * (PALETTE.length - 1);
  const low = Math.min(Math.floor(at), PALETTE.length - 2);
  const mix = at - low;
  const [a, b] = [PALETTE[low], PALETTE[low + 1]];
  return [a[0] + (b[0] - a[0]) * mix, a[1] + (b[1] - a[1]) * mix, a[2] + (b[2] - a[2]) * mix];
}

type Vec = [number, number, number];

function add(a: readonly number[], b: readonly number[], scale = 1): Vec {
  return [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
}

function normalise(a: readonly number[]): Vec {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
}

function cross(a: readonly number[], b: readonly number[]): Vec {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Two directions along the sphere at a point, at right angles to it and to each other. */
function tangents(p: SpacePoint): [Vec, Vec] {
  const helper = Math.abs(p[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const first = normalise(cross(helper, p));
  return [first, cross(p, first)];
}

/** Along the sphere from one point to another, lifted off it in the middle by `lift`. */
function arcPoint(a: SpacePoint, b: SpacePoint, u: number, lift: number): Vec {
  const cos = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const angle = Math.acos(cos);
  let point: Vec;
  if (angle < 1e-4) point = add(a, add(b, a, -1), u);
  else {
    const sin = Math.sin(angle);
    const wa = Math.sin((1 - u) * angle) / sin;
    const wb = Math.sin(u * angle) / sin;
    point = [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
  }
  const radius = 1 + lift * Math.sin(Math.PI * u);
  const unit = normalise(point);
  return [unit[0] * radius, unit[1] * radius, unit[2] * radius];
}

/** A small fixed jitter from 0 to 1, the same for the same inputs. */
function jitter(a: number, b: number): number {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

class Strokes {
  readonly segments: number[] = [];
  readonly spores: number[] = [];

  segment(
    from: readonly number[],
    to: readonly number[],
    colour: readonly number[],
    alpha: number,
    width: number,
    colonies: readonly [number, number],
    u: number,
  ) {
    this.segments.push(...from, ...to, ...colour, alpha, width, colonies[0], colonies[1], u);
  }

  spore(
    at: readonly number[],
    colour: readonly number[],
    alpha: number,
    size: number,
    colony: number,
    u: number,
  ) {
    this.spores.push(...at, ...colour, alpha, size, colony, u);
  }

  /** A stroke through points, each segment knowing how far along it sits. */
  line(
    points: readonly (readonly number[])[],
    colourAt: (u: number) => readonly number[],
    alphaAt: (u: number) => number,
    widthAt: (u: number) => number,
    colonies: readonly [number, number],
    start = 0,
    span = 1,
  ) {
    for (let i = 1; i < points.length; i += 1) {
      const u = start + (span * i) / (points.length - 1);
      this.segment(points[i - 1], points[i], colourAt(u), alphaAt(u), widthAt(u), colonies, u);
    }
  }

  done(): SpaceGeometry {
    return { segments: new Float32Array(this.segments), spores: new Float32Array(this.spores) };
  }
}

/** Line segments and spores, packed as {@link SEGMENT_FLOATS} and {@link SPORE_FLOATS} describe. */
export type SpaceGeometry = { segments: Float32Array; spores: Float32Array };

/** How wide colonies grow: wide when the index is small, so a handful of documents still fill the sphere. */
function colonyScale(count: number): number {
  return Math.min(0.24, Math.max(0.05, 0.6 / Math.sqrt(Math.max(count, 1))));
}

const FROND_STEPS = 10;
const BRANCH_STEPS = 5;
const THREAD_STEPS = 28;

function growColony(strokes: Strokes, colony: SpaceColony, scale: number) {
  const { position: p, genome, tone, index } = colony;
  const [t1, t2] = tangents(p);
  const size = scale * (0.75 + 0.5 * genome.size);
  const self: [number, number] = [index, index];
  const twist = genome.curl[0] * Math.PI;
  for (let f = 0; f < FRONDS; f += 1) {
    const reach = size * (0.25 + genome.reach[f]);
    const bend = (genome.curl[f] - 0.5) * 4.5;
    const rise = genome.lift[f];
    const base = (2 * Math.PI * f) / FRONDS + twist;
    const along = (u: number, angle: number, length: number, from: readonly number[] = p): Vec => {
      const outward = add(add([0, 0, 0], t1, Math.cos(angle)), t2, Math.sin(angle));
      return add(
        add(from, outward, length * u),
        p,
        length * 0.7 * rise * Math.sin(Math.PI * u * 0.8),
      );
    };
    const frond = Array.from({ length: FROND_STEPS + 1 }, (_, s) => {
      const u = s / FROND_STEPS;
      return along(u, base + bend * u * u, reach);
    });
    const warm = (u: number) => paletteAt(tone + 0.22 * u);
    strokes.line(
      frond,
      warm,
      (u) => 0.9 - 0.45 * u,
      (u) => 1.7 - 0.9 * u,
      self,
    );
    strokes.spore(
      frond[FROND_STEPS],
      paletteAt(tone + 0.3),
      0.95,
      3.2 + 2 * genome.reach[f],
      index,
      1,
    );
    if (genome.reach[f] > 0.55) {
      // why: a long frond forks, as colonies do; the fork starts where the frond is past halfway.
      const root = frond[Math.round(FROND_STEPS * 0.55)];
      const side = base + bend * 0.3 + (f % 2 === 0 ? 0.7 : -0.7);
      const branch = Array.from({ length: BRANCH_STEPS + 1 }, (_, s) =>
        along(s / BRANCH_STEPS, side + bend * 0.5 * (s / BRANCH_STEPS), reach * 0.45, root),
      );
      strokes.line(
        branch,
        warm,
        () => 0.55,
        () => 1.0,
        self,
        0.55,
        0.45,
      );
      strokes.spore(branch[BRANCH_STEPS], paletteAt(tone + 0.26), 0.8, 2.4, index, 1);
    }
  }
  const halo = Math.round(6 + genome.halo * 18);
  for (let h = 0; h < halo; h += 1) {
    const angle = (2 * Math.PI * h) / halo + jitter(index, h) * 0.4;
    const radius = size * (1.35 + 0.25 * jitter(h, index));
    const at = add(add(p, t1, Math.cos(angle) * radius), t2, Math.sin(angle) * radius);
    strokes.spore(at, paletteAt(tone - 0.12), 0.5, 2.2, index, 0.9);
  }
  strokes.spore(p, paletteAt(tone), 0.9, 16 * (0.75 + 0.5 * genome.size), index, 0);
  strokes.spore(p, [1, 1, 1], 0.55, 5, index, 0);
}

/** Everything a space draws before any query: its colonies and the threads between them. */
export function spaceGeometry(space: EmbeddingSpace): SpaceGeometry {
  const strokes = new Strokes();
  const scale = colonyScale(space.colonies.length);
  for (const thread of space.threads) {
    const a = space.colonies[thread.a];
    const b = space.colonies[thread.b];
    const points = Array.from({ length: THREAD_STEPS + 1 }, (_, s) =>
      arcPoint(a.position, b.position, s / THREAD_STEPS, 0.05 + 0.08 * thread.strength),
    );
    strokes.line(
      points,
      (u) => paletteAt(a.tone + (b.tone - a.tone) * u),
      () => 0.12 + 0.5 * thread.strength,
      () => 0.8 + 1.6 * thread.strength,
      [thread.a, thread.b],
    );
  }
  for (const colony of space.colonies) growColony(strokes, colony, scale);
  return strokes.done();
}

/** A match as the query draws it: which document, and how close against the other matches, from 0 to 1. */
export type QueryMatch = { index: number; closeness: number };

/** A query's spore where it landed, and a thread from it to each match, brightest to the closest. */
export function queryGeometry(
  space: EmbeddingSpace,
  at: SpacePoint,
  matches: readonly QueryMatch[],
): SpaceGeometry {
  const strokes = new Strokes();
  for (const match of matches) {
    const colony = space.colonies[match.index];
    if (!colony) continue;
    const points = Array.from({ length: THREAD_STEPS + 1 }, (_, s) =>
      arcPoint(at, colony.position, s / THREAD_STEPS, 0.1 + 0.08 * match.closeness),
    );
    strokes.line(
      points,
      (u) =>
        paletteAt(colony.tone * u + 0.5 * (1 - u)).map(
          (c, i) => c + (QUERY_COLOUR[i] - c) * (1 - u) * 0.6,
        ),
      () => 0.35 + 0.6 * match.closeness,
      () => 1.2 + 1.8 * match.closeness,
      [QUERY_COLONY, match.index],
    );
  }
  const [t1, t2] = tangents(at);
  for (let h = 0; h < 14; h += 1) {
    const angle = (2 * Math.PI * h) / 14;
    strokes.spore(
      add(add(at, t1, Math.cos(angle) * 0.07), t2, Math.sin(angle) * 0.07),
      QUERY_COLOUR,
      0.6,
      2.2,
      QUERY_COLONY,
      0,
    );
  }
  strokes.spore(at, QUERY_COLOUR, 1, 20, QUERY_COLONY, 0);
  strokes.spore(at, [1, 1, 1], 0.9, 6, QUERY_COLONY, 0);
  return strokes.done();
}
