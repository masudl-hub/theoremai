/**
 * Thought guarding. A host that renders `thought` events shows the user what
 * they say and loads what they link, as it does a reply: the canary, the
 * system prompt and the user-data markers leak through a thought, and a URL
 * the model was not given carries data out. Nothing in a thought stops a turn
 * (`isGuardedOutput`); each leak is omitted and the rest of the thought
 * released.
 *
 * @module
 */

import {
  canaryHoldFrom,
  canaryLeakRanges,
  createCanaryScanner,
  promptLeakCarry,
} from './canary.ts';
import {
  CANARY_HIT,
  DEFAULT_CHECKS,
  NO_CHECKS,
  PROMPT_ECHO_HIT,
  type ResolvedEgressChecks,
  standardEgressEnforce,
} from './egress.ts';
import { SYSTEM_BOUNDARY } from './egress-patterns.ts';
import { createEgressStream, type EgressStream } from './egress-stream.ts';
import { type GivenUrls, imageLeakSpans, linkLeakSpans } from './egress-urls.ts';
import { type LexiconOverrides, lexiconText } from './lexicon.ts';
import { promptEchoHoldFrom, promptEchoRanges, promptEchoScanFrom } from './prompt-echo.ts';
import { EGRESS_RULES } from './rules.ts';
import type { EgressEnforcer, GuardrailContext, GuardrailHit } from './types.ts';

type OmissionKind = 'image' | 'link' | 'instructions';

const OMIT_KEYS = {
  image: 'thought.omitted_image',
  link: 'thought.omitted_link',
  instructions: 'thought.omitted_instructions',
} as const;

const IMAGE_HIT: GuardrailHit = { rule: EGRESS_RULES.image, severity: 'high' };
const LINK_HIT: GuardrailHit = { rule: EGRESS_RULES.link, severity: 'high' };
const BOUNDARY_HIT: GuardrailHit = { rule: EGRESS_RULES.boundary, severity: 'medium' };

/** A leak the guard replaces with its kind's placeholder. */
interface Omission {
  start: number;
  end: number;
  kind: OmissionKind;
  hit: GuardrailHit;
}

/** What a thought guard lets through: the text to show, and what it omitted from it. */
interface ThoughtRelease {
  text: string;
  /** One hit per rule that omitted something; empty when nothing was. */
  hits: GuardrailHit[];
}

/** One provider call's (or Live cycle's) thought text, released as it clears. */
interface ThoughtGuard {
  /** Read the next thought chunk; the text now clear to show, leaks omitted. */
  push(text: string): ThoughtRelease;
  /** The thought ended: everything still held, leaks omitted. The next thought reads on from it. */
  flush(): ThoughtRelease;
  /** The tail of what was shown that a leak in the next call's thoughts could continue. */
  carryOut(): string;
}

interface ThoughtGuardOptions {
  /** The URL and boundary checks thoughts run; the rest of a policy is for replies. */
  checks?: ResolvedEgressChecks;
  canary?: string;
  /** Guarded against echo alongside the canary. */
  system?: string;
  given?: GivenUrls;
  lexicon?: LexiconOverrides;
  /** Shown text an earlier thought ended on (`carryOut`), read in front and never shown again. */
  carry?: string;
}

/** The checks of `checks` a thought runs: what it would load, and the markers it would show. */
function thoughtChecks(checks: ResolvedEgressChecks): ResolvedEgressChecks | undefined {
  if (!(checks.images || checks.links || checks.boundary)) return undefined;
  return {
    ...NO_CHECKS,
    boundary: checks.boundary,
    ...(checks.images ? { images: checks.images } : {}),
    ...(checks.links ? { links: checks.links } : {}),
  };
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
function createThoughtGuard(options: ThoughtGuardOptions): ThoughtGuard {
  const { checks, canary, given, lexicon } = options;
  const system = canary ? options.system : undefined;
  const scope = (check: object) => ({ ...check, ...(given ? { given } : {}) });
  /** The placeholder for `kind` after `before`, without a second space. */
  function placeholder(kind: OmissionKind, before: string): string {
    const text = lexiconText(OMIT_KEYS[kind], {}, lexicon);
    return /\s$/.test(before) ? text.trimStart() : text;
  }

  let out = canary ? (options.carry ?? '') : '';
  let held = '';
  let stream: EgressStream | undefined;
  let scanner: ReturnType<typeof createCanaryScanner> | undefined;
  /** How far the prompt echo has read `out + held` clean. */
  let echoed = 0;
  /** How much of `out + held` the readers have read. */
  let readTo = 0;
  /** Where a leak still growing at the end of the held text starts; held until it ends. */
  let open: number | undefined;
  /** Set once the rest of the thought is omitted: nothing more is read until the flush. */
  let cut = false;
  let leaks = 0;
  let hits = new Map<string, GuardrailHit>();

  /** Fresh readers over `text`, as if it had streamed: true when it already holds a leak. */
  function restart(text: string): boolean {
    stream = checks ? createEgressStream({ checks, ...(given ? { given } : {}) }) : undefined;
    scanner = canary ? createCanaryScanner(canary) : undefined;
    echoed = 0;
    readTo = 0;
    return read(text);
  }

  /** Read `text`, what follows the read part of `out + held`; true when a leak has settled. */
  function read(text: string): boolean {
    readTo += text.length;
    const urlHit = stream?.push(text) !== undefined;
    const canaryHit = scanner?.push(text) ?? false;
    let echoHit = false;
    if (system) {
      const whole = (out + held).slice(0, readTo);
      const from = promptEchoScanFrom(whole, echoed);
      echoHit = promptEchoRanges(whole.slice(from), system).length > 0;
      echoed = whole.length;
    }
    return urlHit || canaryHit || echoHit;
  }

  function leakSpans(text: string): Omission[] {
    const spans: Omission[] = [];
    if (checks?.images) {
      for (const span of imageLeakSpans(text, scope(checks.images))) {
        spans.push({ ...span, kind: 'image', hit: IMAGE_HIT });
      }
    }
    if (checks?.links) {
      for (const span of linkLeakSpans(text, scope(checks.links), checks.images !== undefined)) {
        spans.push({ ...span, kind: 'link', hit: LINK_HIT });
      }
    }
    if (checks?.boundary) {
      for (const match of text.matchAll(new RegExp(SYSTEM_BOUNDARY.source, 'gi'))) {
        const start = match.index;
        spans.push({
          start,
          end: start + match[0].length,
          kind: 'instructions',
          hit: BOUNDARY_HIT,
        });
      }
    }
    if (canary) {
      for (const [start, end] of canaryLeakRanges(text, canary)) {
        spans.push({ start, end, kind: 'instructions', hit: CANARY_HIT });
      }
    }
    if (system) {
      for (const [start, end] of promptEchoRanges(text, system)) {
        spans.push({ start, end, kind: 'instructions', hit: PROMPT_ECHO_HIT });
      }
    }
    return spans;
  }

  /** The leaks reaching into the held text, in order. */
  function heldLeaks(): Omission[] {
    return merged(leakSpans(out + held)).filter(({ end }) => end > out.length);
  }

  /**
   * Replace each leak reaching into the held text with its placeholder, but
   * for one reaching its end, which the next chunk could continue: that one is
   * held whole (`open`) unless the thought has ended. False when nothing was replaced.
   */
  function omitHeld(ended: boolean): boolean {
    const spans = heldLeaks();
    const whole = out + held;
    const tail = spans.at(-1);
    const growing = !ended && tail !== undefined && tail.end >= whole.length ? tail : undefined;
    const closed = growing ? spans.slice(0, -1) : spans;
    let next = '';
    let at = out.length;
    for (const { start, end, kind, hit } of closed) {
      next += whole.slice(at, Math.max(at, start));
      next += placeholder(kind, out + next);
      hits.set(hit.rule, hit);
      at = end;
    }
    open = undefined;
    if (growing) {
      next += whole.slice(at, Math.max(at, growing.start));
      at = Math.max(at, growing.start);
      open = out.length + next.length;
    }
    held = next + whole.slice(at);
    return closed.length > 0;
  }

  /** Omit the held text from the first leak on; all of it when the leak is in what was shown. */
  function cutRest(): void {
    const first = merged(leakSpans(out + held))[0];
    const from = first ? Math.max(0, first.start - out.length) : 0;
    const kept = held.slice(0, from);
    held = kept + placeholder(first?.kind ?? 'instructions', out + kept);
    if (first) hits.set(first.hit.rule, first.hit);
    open = undefined;
    cut = true;
  }

  /** What the readers read: the thought up to a leak still growing. */
  function readable(): string {
    const whole = out + held;
    return open === undefined ? whole : whole.slice(0, open);
  }

  /** Omit leaks until fresh readers over the thought settle none; failing that, the rest. */
  function settle(): void {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (leaks >= MAX_LEAKS) break;
      if (!omitHeld(false)) {
        // A leak the readers settled that no span covers is cut, not shown.
        if (open === undefined) break;
        return;
      }
      leaks++;
      if (!restart(readable())) return;
    }
    cutRest();
  }

  /** The earliest index of `out + held` a leak could still start at. */
  function holdFrom(): number {
    const end = out.length + held.length;
    const url = stream ? stream.holdFrom() : end;
    const leak = canary ? out.length + canaryHoldFrom(held, canary) : end;
    const echo = system ? out.length + promptEchoHoldFrom(held, system) : end;
    return Math.min(url, leak, echo, open ?? end);
  }

  function release(text: string): ThoughtRelease {
    const shown = { text, hits: [...hits.values()] };
    hits = new Map();
    return shown;
  }

  restart(out);

  return {
    push(text) {
      if (cut || !text) return release('');
      held += text;
      if (open !== undefined || read(text)) settle();
      if (cut) return release('');
      const clear = Math.max(0, holdFrom() - out.length);
      const shown = held.slice(0, clear);
      out += shown;
      held = held.slice(clear);
      return release(shown);
    },
    flush() {
      if (!cut) {
        for (let round = 0; round < MAX_ROUNDS && omitHeld(true); round++);
        // A leak left is one the text shown already takes part in, such as a definition an image opener held here could use.
        if (held && leakSpans(out + held).length > 0) cutRest();
      }
      const shown = held;
      out = canary ? promptLeakCarry(out + held, canary, system) : '';
      held = '';
      open = undefined;
      cut = false;
      leaks = 0;
      restart(out);
      return release(shown);
    },
    carryOut: () => out,
  };
}

/** The checks each egress enforce runs, for the policies whose checks the kernel knows. */
const THOUGHT_CHECKS = new WeakMap<EgressEnforcer, ResolvedEgressChecks>([
  [standardEgressEnforce, DEFAULT_CHECKS],
]);

/** Tell the kernel `enforce` runs `checks`, so thoughts are guarded for the checks they take. */
function registerThoughtChecks(enforce: EgressEnforcer, checks: ResolvedEgressChecks): void {
  THOUGHT_CHECKS.set(enforce, checks);
}

/**
 * A guard for a turn's thoughts: the canary and prompt echo whenever the turn
 * binds a canary, and the URL and boundary checks `enforce` runs.
 */
function thoughtGuardFor(
  enforce: EgressEnforcer | undefined,
  context: GuardrailContext,
  carry?: string,
): ThoughtGuard | undefined {
  const known = enforce && THOUGHT_CHECKS.get(enforce);
  const checks = known ? thoughtChecks(known) : undefined;
  const { canary, system, givenUrls, lexicon } = context;
  if (!(checks || canary)) return undefined;
  return createThoughtGuard({
    ...(checks ? { checks } : {}),
    ...(canary ? { canary } : {}),
    ...(system ? { system } : {}),
    ...(givenUrls ? { given: givenUrls } : {}),
    ...(lexicon ? { lexicon } : {}),
    ...(carry ? { carry } : {}),
  });
}

export type { ThoughtGuard, ThoughtGuardOptions, ThoughtRelease };
export { createThoughtGuard, registerThoughtChecks, thoughtGuardFor };
