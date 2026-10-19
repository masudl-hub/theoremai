/**
 * What the embedding space draws, as flat arrays a GPU takes as they are:
 * each cluster's hub with a spoke to every member, each document's dot, the
 * spanning tree's links between clusters, and a query's dot with a spoke to
 * each match. Every line is a relationship in the vectors; nothing is drawn
 * for show.
 *
 * @module
 */

import type { EmbeddingSpace, SpacePoint } from './embedding-space.ts';

/** Floats per line segment: from (3), to (3), colour (3), alpha, width in CSS pixels, the two slots it reads its state from, and where it sits along its line (0 at the start, 1 at the end). */
export const SEGMENT_FLOATS = 14;
/** Floats per dot: position (3), colour (3), alpha, radius in CSS pixels, its slot, and where it sits along the line that reaches it. */
export const DOT_FLOATS = 10;
/** Stands for the query where a slot would go. */
export const QUERY_SLOT = -1;

/** A cluster's slot: after every document's. */
export function hubSlot(space: EmbeddingSpace, cluster: number): number {
  return space.documents.length + cluster;
}

/** The space's palette, cool to warm: deep teal, cyan, chartreuse, amber, coral. */
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
const QUERY_COLOUR: readonly [number, number, number] = [0.94, 0.96, 1.0];

function paletteAt(tone: number): readonly [number, number, number] {
  const at = Math.min(1, Math.max(0, tone)) * (PALETTE.length - 1);
  const low = Math.min(Math.floor(at), PALETTE.length - 2);
  const mix = at - low;
  const [a, b] = [PALETTE[low], PALETTE[low + 1]];
  return [a[0] + (b[0] - a[0]) * mix, a[1] + (b[1] - a[1]) * mix, a[2] + (b[2] - a[2]) * mix];
}

function mixed(a: readonly number[], b: readonly number[], u: number): number[] {
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

/** Radians each step of an arc may span; a short arc is one straight segment. */
const ARC_STEP = 0.06;

/** Points along the sphere from one point to another, by the shorter great circle. */
function arc(a: SpacePoint, b: SpacePoint): number[][] {
  const cos = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const angle = Math.acos(cos);
  const steps = Math.max(1, Math.ceil(angle / ARC_STEP));
  const sin = Math.sin(angle);
  return Array.from({ length: steps + 1 }, (_, s) => {
    const u = s / steps;
    if (sin < 1e-6) return mixed(a, b, u);
    const wa = Math.sin((1 - u) * angle) / sin;
    const wb = Math.sin(u * angle) / sin;
    return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
  });
}

type Line = {
  from: SpacePoint;
  to: SpacePoint;
  colour: (u: number) => readonly number[];
  alpha: number;
  width: number;
  slots: readonly [number, number];
};

class Strokes {
  readonly segments: number[] = [];
  readonly dots: number[] = [];

  line({ from, to, colour, alpha, width, slots }: Line) {
    const points = arc(from, to);
    for (let i = 1; i < points.length; i += 1) {
      const u = i / (points.length - 1);
      this.segments.push(
        ...points[i - 1],
        ...points[i],
        ...colour(u),
        alpha,
        width,
        slots[0],
        slots[1],
        u,
      );
    }
  }

  dot(
    at: SpacePoint,
    colour: readonly number[],
    alpha: number,
    radius: number,
    slot: number,
    along: number,
  ) {
    this.dots.push(...at, ...colour, alpha, radius, slot, along);
  }

  done(): SpaceGeometry {
    return { segments: new Float32Array(this.segments), dots: new Float32Array(this.dots) };
  }
}

/** Line segments and dots, packed as {@link SEGMENT_FLOATS} and {@link DOT_FLOATS} describe. */
export type SpaceGeometry = { segments: Float32Array; dots: Float32Array };

/** Everything a space draws before any query: the links between clusters, each cluster's spokes and hub, and every document. */
export function spaceGeometry(space: EmbeddingSpace): SpaceGeometry {
  const strokes = new Strokes();
  const toneOf = (index: number) => space.clusters[space.documents[index].cluster].tone;
  for (const link of space.links) {
    const [a, b] = [paletteAt(toneOf(link.a)), paletteAt(toneOf(link.b))];
    strokes.line({
      from: space.documents[link.a].position,
      to: space.documents[link.b].position,
      colour: (u) => mixed(a, b, u),
      alpha: 0.28,
      width: 1,
      slots: [link.a, link.b],
    });
  }
  for (const [k, cluster] of space.clusters.entries()) {
    const colour = paletteAt(cluster.tone);
    if (cluster.members.length < 2) continue;
    for (const member of cluster.members)
      strokes.line({
        from: cluster.hub,
        to: space.documents[member].position,
        colour: () => colour,
        alpha: 0.6,
        width: 1,
        slots: [member, member],
      });
    strokes.dot(cluster.hub, colour, 0.9, 2.4, hubSlot(space, k), 0);
  }
  for (const document of space.documents) {
    const solo = space.clusters[document.cluster].members.length < 2;
    strokes.dot(
      document.position,
      paletteAt(space.clusters[document.cluster].tone),
      1,
      1.8,
      document.index,
      solo ? 0 : 1,
    );
  }
  return strokes.done();
}

/** A match as the query draws it: which document, and how close against the other matches, from 0 to 1. */
export type QueryMatch = { index: number; closeness: number };

/** A query's dot where it landed, and a spoke from it to each match, strongest to the closest. */
export function queryGeometry(
  space: EmbeddingSpace,
  at: SpacePoint,
  matches: readonly QueryMatch[],
): SpaceGeometry {
  const strokes = new Strokes();
  for (const match of matches) {
    const document = space.documents[match.index];
    if (!document) continue;
    const tone = paletteAt(space.clusters[document.cluster].tone);
    strokes.line({
      from: at,
      to: document.position,
      colour: (u) => mixed(QUERY_COLOUR, tone, u),
      alpha: 0.45 + 0.45 * match.closeness,
      width: 1,
      slots: [QUERY_SLOT, match.index],
    });
  }
  strokes.dot(at, QUERY_COLOUR, 1, 3, QUERY_SLOT, 0);
  return strokes.done();
}
