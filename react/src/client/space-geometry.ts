/**
 * What the embedding space draws, as flat arrays a GPU takes as they are:
 * each document's dot, a line for each link, heavier the further its cosine
 * similarity passes the threshold, and a query's ring with a line to each
 * match that passes its own.
 * Every line joins two real points and stands for their cosine similarity;
 * nothing is drawn for show.
 *
 * @module
 */

import type { EmbeddingSpace, SpacePoint } from './embedding-space.ts';

/**
 * Floats per line segment: from (3), to (3), colour (3), alpha, width in CSS
 * pixels, the two slots it reads its state from, where it sits along its line
 * (0 at the start, 1 at the end), and the gap in CSS pixels it leaves before
 * its start and after its end, where a dot sits.
 */
export const SEGMENT_FLOATS = 16;
/** Floats per dot: position (3), colour (3), alpha, radius and ring width in CSS pixels (0 for a solid dot), its slot, and where it sits along the line that reaches it. */
export const DOT_FLOATS = 11;
/** Stands for the query where a slot would go. */
export const QUERY_SLOT = -1;

/** Every cluster's colour has this lightness and chroma, so none reads dirtier or louder than another. */
const LIGHTNESS = 0.72;
const CHROMA = 0.085;
const QUERY_COLOUR: readonly [number, number, number] = [0.97, 0.98, 1.0];
/** Every line is white; only its weight says how alike its two ends are. */
const LINE_COLOUR: readonly [number, number, number] = [1, 1, 1];
/** A line's width in CSS pixels and its opacity, at the threshold and at identical. */
const LINE_WIDTH = [0.4, 0.9] as const;
const LINE_ALPHA = [0.18, 0.6] as const;

function weighted([at, to]: readonly [number, number], strength: number): number {
  return at + (to - at) * strength;
}

function gamma(linear: number): number {
  return linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
}

/** An OKLCH colour as sRGB from 0 to 1, or `null` when the screen cannot show it. */
function oklch(l: number, c: number, hue: number): [number, number, number] | null {
  const a = c * Math.cos(hue);
  const b = c * Math.sin(hue);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  if (rgb.some((v) => v < -1e-4 || v > 1 + 1e-4)) return null;
  return rgb.map((v) => gamma(Math.min(1, Math.max(0, v)))) as [number, number, number];
}

/** A cluster's colour from its tone, a hue from 0 to 1, at the palette's one lightness; chroma gives way only where the screen runs out. */
function colourOf(tone: number): readonly [number, number, number] {
  const hue = tone * 2 * Math.PI;
  for (let c = CHROMA; c > 0; c -= 0.005) {
    const colour = oklch(LIGHTNESS, c, hue);
    if (colour) return colour;
  }
  return oklch(LIGHTNESS, 0, hue) ?? [0.8, 0.8, 0.8];
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
  alpha: number;
  width: number;
  slots: readonly [number, number];
  /** CSS pixels left clear at each end, for the dots there. */
  gaps: readonly [number, number];
};

type Dot = {
  at: SpacePoint;
  colour: readonly number[];
  alpha: number;
  radius: number;
  /** The ring's width, or 0 for a solid dot. */
  ring: number;
  slot: number;
  along: number;
};

class Strokes {
  readonly segments: number[] = [];
  readonly dots: number[] = [];

  line({ from, to, alpha, width, slots, gaps }: Line) {
    const points = arc(from, to);
    const last = points.length - 1;
    for (let i = 1; i <= last; i += 1) {
      const u = i / last;
      this.segments.push(
        ...points[i - 1],
        ...points[i],
        ...LINE_COLOUR,
        alpha,
        width,
        slots[0],
        slots[1],
        u,
        i === 1 ? gaps[0] : 0,
        i === last ? gaps[1] : 0,
      );
    }
  }

  dot({ at, colour, alpha, radius, ring, slot, along }: Dot) {
    this.dots.push(...at, ...colour, alpha, radius, ring, slot, along);
  }

  done(): SpaceGeometry {
    return { segments: new Float32Array(this.segments), dots: new Float32Array(this.dots) };
  }
}

/** Line segments and dots, packed as {@link SEGMENT_FLOATS} and {@link DOT_FLOATS} describe. */
export type SpaceGeometry = { segments: Float32Array; dots: Float32Array };

/** A document's dot, and the query's ring with its centre, in CSS pixels. */
const DOCUMENT_RADIUS = 2.6;
const QUERY_RADIUS = 6;
const QUERY_RING = 1.5;
const QUERY_CORE = 2.4;
/** The clear space between a line's end and the dot it reaches. */
const GAP = 1.75;

/** How far a link passes the threshold, from 0 at it to 1 at identical. */
function strengthOf(space: EmbeddingSpace, similarity: number): number {
  if (space.threshold >= 1) return 1;
  return Math.min(Math.max((similarity - space.threshold) / (1 - space.threshold), 0), 1);
}

/** Everything a space draws before any query: a line for each link, then every document's dot. */
export function spaceGeometry(space: EmbeddingSpace): SpaceGeometry {
  const strokes = new Strokes();
  const colourOfDocument = (index: number) =>
    colourOf(space.clusters[space.documents[index].cluster].tone);
  for (const link of space.links) {
    const strength = strengthOf(space, link.similarity);
    strokes.line({
      from: space.documents[link.a].position,
      to: space.documents[link.b].position,
      alpha: weighted(LINE_ALPHA, strength),
      width: weighted(LINE_WIDTH, strength),
      slots: [link.a, link.b],
      gaps: [DOCUMENT_RADIUS + GAP, DOCUMENT_RADIUS + GAP],
    });
  }
  for (const document of space.documents)
    strokes.dot({
      at: document.position,
      colour: colourOfDocument(document.index),
      alpha: 1,
      radius: DOCUMENT_RADIUS,
      ring: 0,
      slot: document.index,
      along: 0,
    });
  return strokes.done();
}

/** A match the query is joined to. */
export type QueryMatch = {
  index: number;
  /** How far its similarity passes the threshold it stood out against, from 0 at it to 1 at identical. */
  closeness: number;
};

/** A query's ring where it landed, and a line from it to each match, weighted as a link is. */
export function queryGeometry(
  space: EmbeddingSpace,
  at: SpacePoint,
  matches: readonly QueryMatch[],
): SpaceGeometry {
  const strokes = new Strokes();
  for (const match of matches) {
    const document = space.documents[match.index];
    if (!document) continue;
    strokes.line({
      from: at,
      to: document.position,
      alpha: weighted(LINE_ALPHA, match.closeness),
      width: weighted(LINE_WIDTH, match.closeness),
      slots: [QUERY_SLOT, match.index],
      gaps: [QUERY_RADIUS + GAP, DOCUMENT_RADIUS + GAP],
    });
  }
  const query = { at, colour: QUERY_COLOUR, alpha: 1, slot: QUERY_SLOT, along: 0 };
  strokes.dot({ ...query, radius: QUERY_RADIUS, ring: QUERY_RING });
  strokes.dot({ ...query, radius: QUERY_CORE, ring: 0 });
  return strokes.done();
}
