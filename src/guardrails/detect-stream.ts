/**
 * `guardrails.detect` on text released as it streams: a reply, a Live reply, a
 * thought. The stream scanner (`egress-stream.ts`) says where a match could
 * still be under way, so nothing a detector reads is released early, and where
 * one settled; `detectRelease` then reads the stretch being released and takes
 * the action the profile set.
 *
 * @module
 */

import type { Boundary } from './boundaries.ts';
import { detectorsAt, detectRelease, type Release } from './detect-at.ts';
import type { Detector, ResolvedDetect } from './detectors.ts';
import { NO_CHECKS } from './egress.ts';
import { createEgressStream } from './egress-stream.ts';

/** Text read at one boundary as it streams. Indices are of the text as written. */
interface DetectStream {
  /** Read the next piece of the text. */
  push(fragment: string): void;
  /** The earliest index a match could still start at: nothing from there on is released yet. */
  holdFrom(): number;
  /**
   * Release the text from `from` up to `to`, or all of it once it has `ended`:
   * what crosses, what was found in it, and how far the release got.
   */
  take(from: number, to: number, ended?: boolean): Release;
}

/** A reader for text streaming across `boundary`, or `undefined` when no detector reads it. */
function createDetectStream(boundary: Boundary, detect: ResolvedDetect): DetectStream | undefined {
  const detectors = detectorsAt(boundary, detect);
  if (detectors.length === 0) return undefined;
  const stream = createEgressStream({ checks: NO_CHECKS, detect: detectors });
  let window = '';
  /** The matches the stream settled that no release has reached yet. */
  let settled: { start: number; detector: Detector }[] = [];
  return {
    push(fragment) {
      window += fragment;
      for (const { start, detector } of stream.push(fragment)) {
        if (detector) settled.push({ start, detector });
      }
    },
    holdFrom: () => stream.holdFrom(),
    take(from, to, ended = false) {
      const reached = settled.filter(({ start }) => start < to);
      // why: A text that ends mid-match never settles it, so the end is read whole.
      if (reached.length === 0 && !ended) {
        return { action: 'allow', text: window.slice(from, to), hits: [], taken: to - from };
      }
      const stretch = { from, to, settled: reached.map(({ detector }) => detector) };
      const release = detectRelease(window, stretch, boundary, detect);
      settled = settled.filter(({ start }) => start >= from + release.taken);
      return release;
    },
  };
}

export type { DetectStream };
export { createDetectStream };
