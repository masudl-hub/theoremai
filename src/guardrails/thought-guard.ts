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
  CANARY_LEAK_REACH,
  canaryHoldFrom,
  canaryLeakRanges,
  canaryOpeningFrom,
  createCanaryScanner,
  promptLeakCarry,
  RELEASED_LOOKBACK,
  wordStartAcross,
} from './canary.ts';
import {
  boundaryNote,
  CANARY_HIT,
  egressChecksOf,
  NO_CHECKS,
  PROMPT_ECHO_HIT,
  type ResolvedEgressChecks,
} from './egress.ts';
import { notePattern, SYSTEM_BOUNDARY } from './egress-patterns.ts';
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

/** A placeholder in the thought and the text it replaced. */
interface Mark {
  start: number;
  end: number;
  raw: string;
}

/** Text with each placeholder read as what it replaced, and where each piece stands in the thought. */
interface RawView {
  text: string;
  /** Where the held text starts in `text`. */
  held: number;
  pieces: Array<{ raw: number; shown: number; mark?: Mark }>;
}

/** Where `raw`, an offset into `view.text`, stands in the thought: a placeholder's start, or with `end` its end. */
function shownAt(view: RawView, raw: number, end = false): number {
  let piece = view.pieces[0];
  for (const next of view.pieces) {
    if (next.raw > raw || (end && next.raw === raw && raw > 0)) break;
    piece = next;
  }
  if (!piece) return raw;
  if (piece.mark) return end ? piece.mark.end : piece.mark.start;
  return piece.shown + raw - piece.raw;
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
  privateSystem?: readonly string[];
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
 * released is final, and what is held changes only by omission. The canary
 * and prompt echo are read a second time with each placeholder as the text it
 * replaced, so a leak running on past one, or across one longer than its
 * text, is omitted too.
 */
function createThoughtGuard(options: ThoughtGuardOptions): ThoughtGuard {
  const { checks, canary, given, lexicon } = options;
  const privateSystem = canary ? options.privateSystem : undefined;
  const note = boundaryNote({ canary, lexicon });
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
  /** The placeholders in `out + held` a leak reaching the held text could run through, in order. */
  let marks: Mark[] = [];
  /**
   * No canary opening starts in `out + held` before this while the held text
   * only grows and is released: a point further back than `RELEASED_LOOKBACK`
   * that is no opening cannot become one. An omission rewrites the held text,
   * and the hold is read whole again.
   */
  let openingFrom = 0;
  /** Set once the rest of the thought is omitted: nothing more is read until the flush. */
  let cut = false;
  let leaks = 0;
  let hits = new Map<string, GuardrailHit>();

  /** Fresh readers over `text`, as if it had streamed: true when it already holds a leak. */
  function restart(text: string): boolean {
    stream = checks
      ? createEgressStream({ checks, ...(given ? { given } : {}), ...(note ? { note } : {}) })
      : undefined;
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
    if (privateSystem) {
      const whole = (out + held).slice(0, readTo);
      const from = promptEchoScanFrom(whole, echoed);
      echoHit = promptEchoRanges(whole.slice(from), privateSystem, canary).length > 0;
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
      const patterns = [
        new RegExp(SYSTEM_BOUNDARY.source, 'gi'),
        ...(note ? [notePattern(note)] : []),
      ];
      for (const match of patterns.flatMap((pattern) => [...text.matchAll(pattern)])) {
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
    if (privateSystem) {
      for (const [start, end] of promptEchoRanges(text, privateSystem, canary)) {
        spans.push({ start, end, kind: 'instructions', hit: PROMPT_ECHO_HIT });
      }
    }
    return spans;
  }

  /** The mark `at` falls inside, if any. */
  function markAt(at: number): Mark | undefined {
    return marks.find((mark) => mark.start < at && at < mark.end);
  }

  /** `out + held` from `from` to `to`, mark boundaries both, each placeholder as the text it replaced. */
  function rawOf(from: number, to: number): string {
    const whole = out + held;
    let text = '';
    let at = from;
    for (const mark of marks) {
      if (mark.end <= from || mark.start >= to) continue;
      text += whole.slice(at, mark.start) + mark.raw;
      at = mark.end;
    }
    return text + whole.slice(at, to);
  }

  /**
   * The thought from far enough back that a leak reaching the held text
   * starts inside, placeholders read as what they replaced; none when no
   * placeholder is that close, as it then reads as the thought does.
   */
  function rawView(): RawView | undefined {
    const whole = out + held;
    for (let reach = CANARY_LEAK_REACH; ; reach *= 2) {
      let from = out.length;
      let length = 0;
      for (let i = marks.length - 1; from > 0 && length < reach; ) {
        const mark = marks[i];
        if (mark && mark.end > from) {
          i--;
        } else if (mark && mark.end === from) {
          length += mark.raw.length;
          from = mark.start;
          i--;
        } else {
          const stop = Math.max(mark?.end ?? 0, from - (reach - length));
          length += from - stop;
          from = stop;
        }
      }
      marks = marks.filter((mark) => mark.end > from);
      if (marks.length === 0) return undefined;
      const view: RawView = { text: '', held: 0, pieces: [] };
      let at = from;
      for (const mark of [...marks, undefined]) {
        const plain = mark ? mark.start : whole.length;
        if (plain > at) view.pieces.push({ raw: view.text.length, shown: at });
        if (at <= out.length && out.length <= plain) view.held = view.text.length + out.length - at;
        view.text += whole.slice(at, plain);
        if (!mark) break;
        view.pieces.push({ raw: view.text.length, shown: mark.start, mark });
        view.text += mark.raw;
        at = mark.end;
      }
      // why: An echo run is counted in words: read back until it fits, or the thought starts.
      if (!privateSystem || from === 0 || promptEchoScanFrom(view.text, view.held) > 0) return view;
    }
  }

  /** The leaks the raw view finds that leave something held still shown, as spans of the thought. */
  function rawLeaks(): Omission[] {
    const view = rawView();
    if (!view) return [];
    const ranges: Array<[number, number, GuardrailHit]> = [];
    if (canary) {
      for (const [start, end] of canaryLeakRanges(view.text, canary)) {
        ranges.push([start, end, CANARY_HIT]);
      }
    }
    if (privateSystem) {
      for (const [start, end] of promptEchoRanges(view.text, privateSystem, canary)) {
        ranges.push([start, end, PROMPT_ECHO_HIT]);
      }
    }
    const spans: Omission[] = [];
    for (const [rawStart, rawEnd, hit] of ranges) {
      if (rawEnd <= view.held) continue;
      const start = shownAt(view, rawStart);
      const end = shownAt(view, rawEnd, true);
      let shows = false;
      for (let at = Math.max(start, out.length); at < end && !shows; at++) {
        shows = !marks.some((mark) => mark.start <= at && at < mark.end);
      }
      if (shows) spans.push({ start, end, kind: 'instructions', hit });
    }
    return spans;
  }

  /** Every leak in the thought, as shown and as written, overlapping ones as one. */
  function allLeaks(): Omission[] {
    return merged([...leakSpans(out + held), ...rawLeaks()]);
  }

  /** The leaks reaching into the held text, in order. */
  function heldLeaks(): Omission[] {
    return allLeaks().filter(({ end }) => end > out.length);
  }

  /** `at` moved off the inside of a placeholder: back to its start, or with `end` on to its end. */
  function offMark(at: number, end = false): number {
    const mark = markAt(at);
    return mark ? (end ? mark.end : mark.start) : at;
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
    const kept = marks.filter((mark) => mark.end <= out.length);
    let next = '';
    let at = out.length;
    /** Copy `whole` up to `to`, and the marks in it. */
    const copy = (to: number) => {
      const shift = out.length + next.length - at;
      for (const mark of marks) {
        if (mark.start >= at && mark.end <= to) {
          kept.push({ ...mark, start: mark.start + shift, end: mark.end + shift });
        }
      }
      next += whole.slice(at, Math.max(at, to));
      at = Math.max(at, to);
    };
    for (const { start, end, kind, hit } of closed) {
      copy(offMark(start));
      const to = Math.max(at, offMark(end, true));
      const text = placeholder(kind, out + next);
      const begin = out.length + next.length;
      kept.push({ start: begin, end: begin + text.length, raw: rawOf(at, to) });
      next += text;
      hits.set(hit.rule, hit);
      at = to;
    }
    open = undefined;
    if (growing) {
      copy(offMark(growing.start));
      open = out.length + next.length;
    }
    copy(whole.length);
    marks = kept;
    held = next;
    openingFrom = 0;
    return closed.length > 0;
  }

  /** Omit the held text from the first leak on; all of it when the leak is in what was shown. */
  function cutRest(): void {
    const first = allLeaks()[0];
    const from = first ? Math.max(0, offMark(first.start) - out.length) : 0;
    const kept = held.slice(0, from);
    const text = placeholder(first?.kind ?? 'instructions', out + kept);
    const begin = out.length + from;
    const raw = rawOf(begin, out.length + held.length);
    marks = marks.filter((mark) => mark.end <= begin);
    marks.push({ start: begin, end: begin + text.length, raw });
    held = kept + text;
    openingFrom = 0;
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
      const before = new Set(marks.map((mark) => mark.start));
      if (!omitHeld(false)) {
        // why: A leak the readers settled that no span covers is cut, not shown.
        if (open === undefined) break;
        return;
      }
      // why: A leak running on past its placeholder only grows it.
      if (marks.some((mark) => !before.has(mark.start))) leaks++;
      if (!restart(readable())) return;
    }
    cutRest();
  }

  /** The earliest index of `out + held` a leak could still start at, moved back to the start of a word it cuts. */
  function holdFrom(): number {
    const end = out.length + held.length;
    const url = stream ? stream.holdFrom() : end;
    const leak = canary ? canaryFrom(canary) : end;
    const echo = privateSystem ? out.length + promptEchoHoldFrom(held, privateSystem, canary) : end;
    const from = Math.min(url, leak, echo, rawHoldFrom() ?? end, open ?? end);
    return offMark(
      from < out.length ? from : out.length + wordStartAcross(held, from - out.length),
    );
  }

  /** `canaryHoldFrom` on the held text, as an index of `out + held`, read from where an opening could start. */
  function canaryFrom(canary: string): number {
    const from = Math.max(out.length, openingFrom);
    const lead = Math.max(0, from - RELEASED_LOOKBACK);
    let at = lead + canaryOpeningFrom(textFrom(lead), canary);
    if (at < from && from > out.length) {
      const whole = Math.max(0, out.length - RELEASED_LOOKBACK);
      at = whole + canaryOpeningFrom(textFrom(whole), canary);
    }
    openingFrom = Math.min(at, out.length + held.length - RELEASED_LOOKBACK);
    return Math.max(out.length, at);
  }

  /** `out + held` from `from` on. */
  function textFrom(from: number): string {
    return from < out.length ? out.slice(from) + held : held.slice(from - out.length);
  }

  /** The hold as the raw view reads it: an opening a placeholder spent may not be spent. */
  function rawHoldFrom(): number | undefined {
    const view = rawView();
    if (!view) return undefined;
    const rest = view.text.slice(view.held);
    const leak = canary ? canaryHoldFrom(rest, canary, view.text.slice(0, view.held)) : rest.length;
    const echo = privateSystem ? promptEchoHoldFrom(rest, privateSystem, canary) : rest.length;
    return shownAt(view, view.held + Math.min(leak, echo));
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
      if (open !== undefined || read(text) || rawLeaks().length > 0) settle();
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
        // why: A leak left is one the text shown already takes part in, such as a definition an image opener held here could use.
        if (held && (leakSpans(out + held).length > 0 || rawLeaks().length > 0)) cutRest();
      }
      const shown = held;
      const whole = out + held;
      out = canary ? promptLeakCarry(whole, canary, privateSystem) : '';
      const shift = out.length - whole.length;
      marks = marks
        .filter((mark) => mark.start + shift >= 0)
        .map((mark) => ({ ...mark, start: mark.start + shift, end: mark.end + shift }));
      held = '';
      openingFrom = 0;
      open = undefined;
      cut = false;
      leaks = 0;
      restart(out);
      return release(shown);
    },
    carryOut: () => out,
  };
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
  const known = egressChecksOf(enforce);
  const checks = known ? thoughtChecks(known) : undefined;
  const { canary, privateSystem, givenUrls, lexicon } = context;
  if (!(checks || canary)) return undefined;
  return createThoughtGuard({
    ...(checks ? { checks } : {}),
    ...(canary ? { canary } : {}),
    ...(privateSystem ? { privateSystem } : {}),
    ...(givenUrls ? { given: givenUrls } : {}),
    ...(lexicon ? { lexicon } : {}),
    ...(carry ? { carry } : {}),
  });
}

export type { ThoughtGuard, ThoughtGuardOptions, ThoughtRelease };
export { createThoughtGuard, thoughtGuardFor };
