/**
 * Where the earliest match of the bundled egress policy or a detector starts in
 * the raw text, found by running every view whole and mapping each view index back
 * by hand. It shares no code with `egress-stream.ts`, so the stream tests can
 * check the hold against it.
 *
 * @module
 */

import type { Detector } from '../../src/guardrails/detectors.ts';
import { DEFAULT_CHECKS, type ResolvedEgressChecks } from '../../src/guardrails/egress.ts';
import { REVERSED_INJECTION_PATTERNS } from '../../src/guardrails/egress-automata.ts';
import { EGRESS_PATTERNS, type EgressPattern } from '../../src/guardrails/egress-patterns.ts';
import {
  type GivenUrls,
  imageLeakSpans,
  linkLeakSpans,
  type UrlScope,
} from '../../src/guardrails/egress-urls.ts';
import {
  decodeUrlRuns,
  INJECTION_BLOBS,
  tryLeet,
  tryRot13,
  typoNormalize,
} from '../../src/guardrails/injection.ts';
import { normalizeCodePoint, normalizeForDetection } from '../../src/guardrails/normalize.ts';
import { cardHit, SENSITIVE_PATTERNS } from '../../src/guardrails/sensitive.ts';
import { REPLY_DETECTORS } from '../fixtures/detect.ts';

interface MappedView {
  view: string;
  /** Raw index of each view index. */
  at: number[];
}

interface Matcher {
  re: RegExp;
  hit?: (match: string, view: string, at: number) => boolean;
}

const EMOJI_BETWEEN =
  /(?<=[a-zA-Z])(?:[\u{1F300}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{231A}-\u{23FF}])+(?=[a-zA-Z])/gu;

function withoutMatches({ view, at }: MappedView, re: RegExp): MappedView {
  let kept = '';
  const keptAt: number[] = [];
  let last = 0;
  for (const m of view.matchAll(re)) {
    kept += view.slice(last, m.index);
    keptAt.push(...at.slice(last, m.index));
    last = m.index + m[0].length;
  }
  return { view: kept + view.slice(last), at: [...keptAt, ...at.slice(last)] };
}

function normalizedView(text: string): MappedView {
  let mapped: MappedView = { view: '', at: [] };
  for (let i = 0; i < text.length; ) {
    const width = (text.codePointAt(i) as number) > 0xffff ? 2 : 1;
    const folded = normalizeCodePoint(text.slice(i, i + width));
    for (let k = 0; k < folded.length; k++) mapped.at.push(i);
    mapped.view += folded;
    i += width;
  }
  mapped = withoutMatches(withoutMatches(mapped, EMOJI_BETWEEN), /\\(?=[a-zA-Z])/g);
  if (mapped.view !== normalizeForDetection(text))
    throw new Error('reference normalized view drifted');
  return mapped;
}

function urlView(text: string): MappedView {
  const mapped: MappedView = { view: '', at: [] };
  let last = 0;
  const keep = (to: number) => {
    for (let i = last; i < to; i++) {
      mapped.view += text[i];
      mapped.at.push(i);
    }
  };
  for (const m of text.matchAll(/(?:%[0-9A-Fa-f]{2})+/g)) {
    keep(m.index);
    const decoded = decodeUrlRuns(m[0]);
    mapped.view += decoded;
    for (let k = 0; k < decoded.length; k++) mapped.at.push(m.index);
    last = m.index + m[0].length;
  }
  keep(text.length);
  if (mapped.view !== decodeUrlRuns(text)) throw new Error('reference url view drifted');
  return mapped;
}

const blobHits = new Map(INJECTION_BLOBS.map((blob) => [blob.pattern, blob.hit]));

/** Whether `checks` reads a plain pattern; image and link patterns are read by their spans. */
function plainRuns(
  { kind, group }: EgressPattern,
  checks: ResolvedEgressChecks,
  detectors: readonly Detector[],
): boolean {
  if (kind === 'image' || kind === 'link') return false;
  if (kind === 'sensitive' || kind === 'card') return detectors.includes(group as 'ids');
  if (kind === 'boundary') return checks.boundary;
  return detectors.includes('injection');
}

const sensitiveHits = new Map(SENSITIVE_PATTERNS.map(({ pattern, hit }) => [pattern, hit]));

function plainMatchers(checks: ResolvedEgressChecks, detectors: readonly Detector[]): Matcher[] {
  return EGRESS_PATTERNS.filter((entry) => plainRuns(entry, checks, detectors)).map(
    ({ kind, pattern }) => ({
      re: pattern,
      hit: kind === 'card' ? cardHit : (blobHits.get(pattern) ?? sensitiveHits.get(pattern)),
    }),
  );
}
const INJECTION: Matcher[] = EGRESS_PATTERNS.filter(({ kind }) => kind === 'injection').map(
  ({ pattern }) => ({ re: pattern }),
);
const REVERSED: Matcher[] = REVERSED_INJECTION_PATTERNS.map((re) => ({ re }));

function earliest(view: string, at: (i: number) => number, matchers: Matcher[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const { re, hit } of matchers) {
    for (const m of view.matchAll(re)) {
      if (m[0] && (!hit || hit(m[0], view, m.index))) {
        best = Math.min(best, at(m.index));
        break;
      }
    }
  }
  return best;
}

/**
 * Where the earliest leaking image starts. A reference definition leaks from
 * its own start when an image opener comes before it ends, and otherwise from
 * the first opener after it: the definition alone renders nothing.
 */
function earliestImage(text: string, images: UrlScope): number {
  const openers = [...text.matchAll(/!\[/g)].map((m) => m.index);
  let best = Number.POSITIVE_INFINITY;
  for (const { start, end } of imageLeakSpans(text, images)) {
    const definition = text[start] !== '!' && text[start] !== '<';
    const opener = openers.find((at) => at + 2 > end) ?? Number.POSITIVE_INFINITY;
    const early = openers.some((at) => at + 2 <= end);
    best = Math.min(best, definition && !early ? opener : start);
  }
  return best;
}

function earliestLink(text: string, links: UrlScope, skipImages: boolean): number {
  return Math.min(...linkLeakSpans(text, links, skipImages).map(({ start }) => start));
}

/** The raw index the earliest match starts at, or `Infinity` when nothing matches. */
function referenceMatchStart(
  text: string,
  checks: ResolvedEgressChecks = DEFAULT_CHECKS,
  given?: GivenUrls,
  detectors: readonly Detector[] = REPLY_DETECTORS,
): number {
  const same = (i: number) => i;
  const scope = (check: object) => ({ ...check, ...(given ? { given } : {}) });
  const urls = Math.min(
    checks.images ? earliestImage(text, scope(checks.images)) : Number.POSITIVE_INFINITY,
    checks.links
      ? earliestLink(text, scope(checks.links), checks.images !== undefined)
      : Number.POSITIVE_INFINITY,
  );
  const plain = Math.min(earliest(text, same, plainMatchers(checks, detectors)), urls);
  if (!detectors.includes('injection')) return plain;
  const normalized = normalizedView(text);
  const fromNormalized = (i: number) => normalized.at[i] as number;
  const url = urlView(text);
  return Math.min(
    plain,
    earliest(text, same, REVERSED),
    earliest(typoNormalize(text), same, INJECTION),
    earliest(normalized.view, fromNormalized, INJECTION),
    earliest(typoNormalize(normalized.view), fromNormalized, INJECTION),
    earliest(tryRot13(text), same, INJECTION),
    earliest(tryLeet(text) ?? text, same, INJECTION),
    earliest(url.view, (i) => url.at[i] as number, INJECTION),
  );
}

export { referenceMatchStart };
