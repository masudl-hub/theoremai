/**
 * Thought guarding. A host that renders `thought` events loads a thought's
 * images, and links it, as it does a reply's: a URL the model was not given
 * carries data out either way. Thoughts are not guarded output
 * (`isGuardedOutput`), so nothing here stops a turn; each leaking image or
 * link is omitted and the rest of the thought released.
 *
 * @module
 */

import {
  DEFAULT_CHECKS,
  NO_CHECKS,
  type ResolvedEgressChecks,
  standardEgressEnforce,
} from './egress.ts';
import { createEgressStream, type EgressStream, type EgressStreamHit } from './egress-stream.ts';
import { type GivenUrls, imageLeakSpans, linkLeakSpans } from './egress-urls.ts';
import { EGRESS_RULES } from './rules.ts';
import type { EgressEnforcer } from './types.ts';

// A space ends a URL the text before runs up to; no brackets, which after a `!` or `]` would open an image or link.
const OMIT_IMAGE = ' (omitted - image)';
const OMIT_LINK = ' (omitted - link)';

/** A leak the guard replaces with `placeholder`. */
interface Omission {
  start: number;
  end: number;
  placeholder: string;
}

/** One provider call's (or Live cycle's) thought text, released as it clears. */
interface ThoughtGuard {
  /** Read the next thought chunk; the text now clear to show, leaks omitted. */
  push(text: string): string;
  /** The thought ended: everything still held, leaks omitted. The guard starts over. */
  flush(): string;
}

/** The URL checks of `checks`, alone: thoughts are guarded for what renders, not what they say. */
function urlChecks(checks: ResolvedEgressChecks): ResolvedEgressChecks | undefined {
  if (!(checks.images || checks.links)) return undefined;
  return {
    ...NO_CHECKS,
    ...(checks.images ? { images: checks.images } : {}),
    ...(checks.links ? { links: checks.links } : {}),
  };
}

/** The placeholder for what `hit` found. */
function placeholderFor(hit: EgressStreamHit): string {
  return hit.rule === EGRESS_RULES.link ? OMIT_LINK : OMIT_IMAGE;
}

/** Sorted, with overlapping leaks as one: an image's URL is a bare link too. */
function merged(spans: Omission[]): Omission[] {
  const out: Omission[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
    else out.push({ ...span });
  }
  return out;
}

/** Omitting one leak can join what was around it into another; past this many rounds, the rest goes. */
const MAX_ROUNDS = 8;

/** Each leak rereads the thought; a thought still writing them past this many loses the rest. */
const MAX_LEAKS = 16;

/**
 * The guard reads the thought as it will be shown, placeholders in: text
 * released is final, and what is held changes only by omission.
 */
function createThoughtGuard(checks: ResolvedEgressChecks, given?: GivenUrls): ThoughtGuard {
  const scope = (check: object) => ({ ...check, ...(given ? { given } : {}) });
  const fresh = (): EgressStream => createEgressStream({ checks, ...(given ? { given } : {}) });
  let out = '';
  let held = '';
  let stream = fresh();
  /** Set once the rest of the thought is omitted: nothing more is read until the flush. */
  let cut = false;
  let leaks = 0;

  function leakSpans(text: string): Omission[] {
    const images = checks.images ? imageLeakSpans(text, scope(checks.images)) : [];
    const links = checks.links
      ? linkLeakSpans(text, scope(checks.links), checks.images !== undefined)
      : [];
    return [
      ...images.map((span) => ({ ...span, placeholder: OMIT_IMAGE })),
      ...links.map((span) => ({ ...span, placeholder: OMIT_LINK })),
    ];
  }

  /** Replace each leak reaching into the held text with its placeholder; false when there is none. */
  function omitHeld(): boolean {
    const whole = out + held;
    const spans = merged(leakSpans(whole)).filter(({ end }) => end > out.length);
    if (spans.length === 0) return false;
    let next = '';
    let at = out.length;
    for (const { start, end, placeholder } of spans) {
      next += whole.slice(at, Math.max(at, start)) + placeholder;
      at = end;
    }
    held = next + whole.slice(at);
    return true;
  }

  /** Omit the held text from `from` on. */
  function cutFrom(from: number, placeholder: string): void {
    held = held.slice(0, Math.max(0, from - out.length)) + placeholder;
    cut = true;
  }

  /** Omit leaks until a fresh stream over the thought holds none; failing that, the rest. */
  function settle(hit: EgressStreamHit): void {
    if (++leaks > MAX_LEAKS) {
      cutFrom(hit.start, placeholderFor(hit));
      return;
    }
    let last = hit;
    for (let round = 0; round < MAX_ROUNDS && omitHeld(); round++) {
      stream = fresh();
      const next = stream.push(out + held);
      if (!next) return;
      last = next;
    }
    cutFrom(last.start, placeholderFor(last));
  }

  return {
    push(text) {
      if (cut) return '';
      held += text;
      const hit = stream.push(text);
      if (hit) settle(hit);
      if (cut) return '';
      const clear = Math.max(0, stream.holdFrom() - out.length);
      const shown = held.slice(0, clear);
      out += shown;
      held = held.slice(clear);
      return shown;
    },
    flush() {
      for (let round = 0; round < MAX_ROUNDS && omitHeld(); round++);
      // A leak left is one the text shown already takes part in, such as a definition an image opener held here could use.
      const left = leakSpans(out + held)[0];
      if (left && held) held = left.placeholder;
      const shown = held;
      out = '';
      held = '';
      stream = fresh();
      cut = false;
      leaks = 0;
      return shown;
    },
  };
}

/** The checks each egress enforce runs, for the policies whose checks the kernel knows. */
const THOUGHT_CHECKS = new WeakMap<EgressEnforcer, ResolvedEgressChecks>([
  [standardEgressEnforce, DEFAULT_CHECKS],
]);

/** Tell the kernel `enforce` runs `checks`, so thoughts are guarded for its URL checks. */
function registerThoughtChecks(enforce: EgressEnforcer, checks: ResolvedEgressChecks): void {
  THOUGHT_CHECKS.set(enforce, checks);
}

/** A guard for the thoughts of a turn `enforce` guards, when it runs a URL check. */
function thoughtGuardFor(
  enforce: EgressEnforcer | undefined,
  given?: GivenUrls,
): ThoughtGuard | undefined {
  const known = enforce && THOUGHT_CHECKS.get(enforce);
  const checks = known && urlChecks(known);
  return checks ? createThoughtGuard(checks, given) : undefined;
}

export type { ThoughtGuard };
export { createThoughtGuard, OMIT_IMAGE, OMIT_LINK, registerThoughtChecks, thoughtGuardFor };
