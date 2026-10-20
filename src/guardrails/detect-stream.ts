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
import {
  type DetectScope,
  detectorsAt,
  detectRelease,
  hostAt,
  isScoped,
  type Release,
} from './detect-at.ts';
import {
  type Detector,
  HOST_FIND_HOLD,
  HOST_FIND_HOLD_LIVE,
  type ResolvedDetect,
} from './detectors.ts';
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

/**
 * A reader for text streaming across `boundary` in a turn of `scope`, or `undefined` when no
 * detector it streams reads it. `canary_leak` and `prompt_leak` (`isScoped`) are not among them:
 * the gate at the boundary reads those as the text grows. Nor are the detectors in `leave`, which
 * another reader at the boundary has.
 */
function createDetectStream(
  boundary: Boundary,
  detect: ResolvedDetect,
  scope: DetectScope = {},
  leave: readonly Detector[] = [],
): DetectStream | undefined {
  const theirs = detectorsAt(boundary, detect).filter(
    (detector) => !(isScoped(detector) || leave.includes(detector)),
  );
  const hosts = hostAt(boundary, detect);
  if (theirs.length === 0 && hosts.length === 0) return undefined;
  const detectors = [...theirs, ...hosts.map(({ id }) => id)];
  const sources = detect.sources ?? {};
  /** The host's patterns, with whose they are: a detector they add to, or one of the host's own. */
  const own = [
    ...theirs.map((detector) => ({ detector, ...sources[detector] })),
    ...hosts.map(({ id, matchers, compiled }) => ({ detector: id, matchers, compiled })),
  ];
  // why: A host's patterns with no table have no automaton to hold by, so nothing is released
  // until the text ends and is read whole. Registration refuses such a profile.
  const unheld = own.some(({ matchers, compiled }) => matchers?.length && !compiled);
  const stream = createEgressStream({
    detect: theirs.filter((detector) => sources[detector]?.theorem !== false),
    own: own.flatMap(({ detector, compiled, matchers = [] }) =>
      compiled ? [{ detector, compiled, matchers }] : [],
    ),
    skipImages: detect.ungiven_images[boundary] !== 'ignore',
    ...(scope.allow ? { allow: scope.allow } : {}),
    ...(scope.givenUrls ? { given: scope.givenUrls } : {}),
    ...(scope.note ? { note: scope.note } : {}),
    ...(scope.ownTools ? { tools: scope.ownTools } : {}),
  });
  // why: A `find` says nothing of where a match could still start, so a fixed tail stays held and
  // every release is read: a match no longer than the tail is caught whole.
  const finds = hosts.some(({ find }) => find);
  const tail = boundary === 'live_reply' ? HOST_FIND_HOLD_LIVE : HOST_FIND_HOLD;
  let window = '';
  /** The matches the stream settled that no release has reached yet. */
  let settled: { start: number; detector: string }[] = [];
  return {
    push(fragment) {
      window += fragment;
      for (const { start, detector } of stream.push(fragment)) {
        if (detector) settled.push({ start, detector });
      }
    },
    holdFrom() {
      if (unheld) return 0;
      const held = stream.holdFrom();
      return finds ? Math.min(held, Math.max(0, window.length - tail)) : held;
    },
    take(from, to, ended = false) {
      const reached = settled.filter(({ start }) => start < to);
      // why: A text that ends mid-match never settles it, so the end is read whole.
      if (reached.length === 0 && !ended && !finds) {
        return { action: 'allow', text: window.slice(from, to), hits: [], taken: to - from };
      }
      const stretch = { from, to, settled: reached.map(({ detector }) => detector) };
      const release = detectRelease(window, stretch, boundary, detect, { detectors, scope });
      settled = settled.filter(({ start }) => start >= from + release.taken);
      return release;
    },
  };
}

export type { DetectStream };
export { createDetectStream };
