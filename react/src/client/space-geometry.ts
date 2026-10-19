/**
 * What the embedding space draws, as flat arrays a GPU takes as they are:
 * the axes' three circles, each document's dot, a line for each link, heavier
 * the further its cosine similarity passes the threshold, and a query's white
 * dot with a line to each match that passes its own.
 * Every other line joins two real points and stands for their cosine
 * similarity; nothing is drawn for show.
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
/** Floats per dot: position (3), colour (3), alpha, radius in CSS pixels, its slot, and where it sits along the line that reaches it. */
export const DOT_FLOATS = 10;
/** Stands for the query where a slot would go. */
export const QUERY_SLOT = -1;
/** Stands for the axes' circles, which no document's state reaches. */
export const FRAME_SLOT = -2;

/** Every cluster's colour has this lightness and chroma, so none reads dirtier or louder than another. */
const LIGHTNESS = 0.72;
const CHROMA = 0.085;
const QUERY_COLOUR: readonly [number, number, number] = [0.97, 0.98, 1.0];
/**
 * Every line is a faint hairline in its documents' colour: it hints at a
 * connection, and the dots carry the picture. Its width in CSS pixels and its
 * opacity, at the threshold and at identical.
 */
const LINE_WIDTH = [0.3, 0.5] as const;
const LINE_ALPHA = [0.18, 0.4] as const;

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

/** The longest piece a line is cut into, so depth fades along it, not only at its ends. */
const PIECE = 0.1;

/** Points along the straight line from one point to another, through the ball. */
function pieces(a: SpacePoint, b: SpacePoint): number[][] {
  const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / PIECE));
  return Array.from({ length: steps + 1 }, (_, s) => mixed(a, b, s / steps));
}

type Line = {
  from: SpacePoint;
  to: SpacePoint;
  colour: (u: number) => readonly number[];
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
  slot: number;
  along: number;
};

class Strokes {
  readonly segments: number[] = [];
  readonly dots: number[] = [];

  line({ from, to, colour, alpha, width, slots, gaps }: Line) {
    const points = pieces(from, to);
    const last = points.length - 1;
    for (let i = 1; i <= last; i += 1) {
      const u = i / last;
      this.segments.push(
        ...points[i - 1],
        ...points[i],
        ...colour((i - 0.5) / last),
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

  /** One segment no document's state reaches, always shown, with no gaps. */
  segment(
    from: SpacePoint,
    to: SpacePoint,
    colour: readonly number[],
    alpha: number,
    width: number,
  ) {
    this.segments.push(...from, ...to, ...colour, alpha, width, FRAME_SLOT, FRAME_SLOT, 0, 0, 0);
  }

  dot({ at, colour, alpha, radius, slot, along }: Dot) {
    this.dots.push(...at, ...colour, alpha, radius, slot, along);
  }

  done(): SpaceGeometry {
    return { segments: new Float32Array(this.segments), dots: new Float32Array(this.dots) };
  }
}

/** Line segments and dots, packed as {@link SEGMENT_FLOATS} and {@link DOT_FLOATS} describe. */
export type SpaceGeometry = { segments: Float32Array; dots: Float32Array };

/** A document's dot, and the query's, a little larger, in CSS pixels. */
const DOCUMENT_RADIUS = 2.6;
const QUERY_RADIUS = 3.6;
/** The clear space between a line's end and the dot it reaches. */
const GAP = 1.75;

/** How far a link passes the threshold, from 0 at it to 1 at identical. */
function strengthOf(space: EmbeddingSpace, similarity: number): number {
  if (space.threshold >= 1) return 1;
  return Math.min(Math.max((similarity - space.threshold) / (1 - space.threshold), 0), 1);
}

/** The axes' circles: a hairline round the rim in each plane two of the three axes span. */
const FRAME_COLOUR = [0.88, 0.9, 0.94] as const;
/** At the ball's front; the renderer fades a circle with the square of its depth, toward a quarter of this at the back. */
const FRAME_ALPHA = 0.29;
const FRAME_WIDTH = 0.7;
const FRAME_STEPS = 96;

function frame(strokes: Strokes) {
  const planes = [
    (a: number): SpacePoint => [Math.cos(a), Math.sin(a), 0],
    (a: number): SpacePoint => [Math.cos(a), 0, Math.sin(a)],
    (a: number): SpacePoint => [0, Math.cos(a), Math.sin(a)],
  ];
  for (const at of planes)
    for (let i = 0; i < FRAME_STEPS; i += 1)
      strokes.segment(
        at((i / FRAME_STEPS) * 2 * Math.PI),
        at(((i + 1) / FRAME_STEPS) * 2 * Math.PI),
        FRAME_COLOUR,
        FRAME_ALPHA,
        FRAME_WIDTH,
      );
}

/** Everything a space draws before any query: the axes' circles, a line for each link, then every document's dot. */
export function spaceGeometry(space: EmbeddingSpace): SpaceGeometry {
  const strokes = new Strokes();
  frame(strokes);
  const colourOfDocument = (index: number) =>
    colourOf(space.clusters[space.documents[index].cluster].tone);
  for (const link of space.links) {
    const strength = strengthOf(space, link.similarity);
    // invariant: a link's two documents are in one cluster, so it takes their colour.
    const colour = colourOfDocument(link.a);
    strokes.line({
      from: space.documents[link.a].position,
      to: space.documents[link.b].position,
      colour: () => colour,
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

/** A query's white dot where it landed, and a line from it to each match, weighted as a link is. */
export function queryGeometry(
  space: EmbeddingSpace,
  at: SpacePoint,
  matches: readonly QueryMatch[],
): SpaceGeometry {
  const strokes = new Strokes();
  for (const match of matches) {
    const document = space.documents[match.index];
    if (!document) continue;
    const colour = colourOf(space.clusters[document.cluster].tone);
    strokes.line({
      from: at,
      to: document.position,
      colour: (u) => mixed(QUERY_COLOUR, colour, u),
      alpha: weighted(LINE_ALPHA, match.closeness),
      width: weighted(LINE_WIDTH, match.closeness),
      slots: [QUERY_SLOT, match.index],
      gaps: [QUERY_RADIUS + GAP, DOCUMENT_RADIUS + GAP],
    });
  }
  strokes.dot({
    at,
    colour: QUERY_COLOUR,
    alpha: 1,
    radius: QUERY_RADIUS,
    slot: QUERY_SLOT,
    along: 0,
  });
  return strokes.done();
}
