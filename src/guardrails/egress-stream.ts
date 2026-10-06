/**
 * The detectors and a host's egress rules, run on a reply as it streams.
 *
 * Each matches its patterns on the reply as written and, for
 * injection phrasing, on
 * rewrites of it (typo-folded, Unicode-folded, rot13, leet, URL-decoded, read
 * backwards). The stream keeps each rewrite growing with the reply and, for
 * every pattern, an automaton accepting every match of it and more
 * (`egress-automata.ts`). Text is held from the earliest place any match could
 * still be under way in any rewrite, and nowhere else: a match that completes
 * later starts at or after that place, so none of it has been released.
 *
 * A match whose outcome no later text can change is settled; a settled match
 * of the pattern itself (not the automaton) is a hit. A hit of the policy
 * blocks the reply there; a detector's does what `guardrails.detect` sets
 * (`detect-stream.ts`). Each character is read a bounded number of times, so a
 * long reply costs time in proportion to its length.
 *
 * @module
 */

import type { Detector, ResolvedAllow } from './detectors.ts';
import {
  FORWARD_AUTOMATON,
  REVERSED_AUTOMATON,
  REVERSED_INJECTION_PATTERNS,
} from './egress-automata.ts';
import {
  EGRESS_PATTERNS,
  type EgressPattern,
  type EgressPatternKind,
  notePattern,
} from './egress-patterns.ts';
import { type EgressAutomatonData, globalPattern } from './egress-rules.ts';
import {
  type GivenUrls,
  IMAGE_PATTERNS,
  imageReadings,
  LINK_PATTERNS,
  linkReadings,
  type UrlPatternReading,
} from './egress-urls.ts';
import {
  decodeUrlRuns,
  INJECTION_BLOBS,
  TYPO_TARGETS,
  tryLeet,
  tryRot13,
  typoNormalize,
} from './injection.ts';
import { isEmoji, normalizeCodePoint } from './normalize.ts';
import { DETECT_RULES } from './rules.ts';
import { cardHit, SENSITIVE_PATTERNS } from './sensitive.ts';
import type { EgressEnforcer, GuardrailContext, Severity } from './types.ts';

/** A settled match. */
interface EgressStreamHit {
  rule: string;
  severity: Severity;
  /** Where in the reply the match starts (the start of its rewrite's source). */
  start: number;
  /** The detector whose match it is; unset for a match of the policy, which blocks. */
  detector?: Detector;
}

interface EgressStream {
  /**
   * Read the next piece of the reply; the matches that settled, none when the reply is clear so
   * far. A match of the policy is the last one read: it blocks.
   */
  push: (chunk: string) => EgressStreamHit[];
  /** The earliest index of the reply a match could still start at. */
  holdFrom: () => number;
}

interface Automaton {
  classOf: Uint16Array;
  /** Per charset, per class: 1 when the class is in the set. */
  has: Uint8Array[];
  pattern: Int32Array;
  final: Uint8Array;
  /** Per node: target, charset, target, charset, ... */
  edges: Int32Array[];
  initials: readonly number[];
  /** Per pattern: the charset an optional repeat opening it reads, or -1. */
  leads: readonly number[];
  size: number;
}

const UNITS = 0x10000;

function compile(data: EgressAutomatonData): Automaton {
  const classCount = data.classStarts.length;
  const classOf = new Uint16Array(UNITS);
  for (let k = 0; k < classCount; k++) {
    classOf.fill(k, data.classStarts[k], data.classStarts[k + 1] ?? UNITS);
  }
  const has = data.charsets.map((classes) => {
    const row = new Uint8Array(classCount);
    for (const k of classes) row[k] = 1;
    return row;
  });
  const size = data.nodes.length;
  const pattern = new Int32Array(size);
  const final = new Uint8Array(size);
  const edges: Int32Array[] = [];
  data.nodes.forEach((node, id) => {
    pattern[id] = node[0] as number;
    final[id] = node[1] as number;
    edges.push(Int32Array.from(node.slice(2)));
  });
  return { classOf, has, pattern, final, edges, initials: data.initials, leads: data.leads, size };
}

let forward: Automaton | undefined;
let backward: Automaton | undefined;

/** The code units a case-insensitive regex reads as each one: ES `Canonicalize` without `u`. */
let caseUnits: Map<number, number[]> | undefined;

function canonicalUnit(unit: number): number {
  const upper = String.fromCharCode(unit).toUpperCase();
  if (upper.length !== 1) return unit;
  const code = upper.charCodeAt(0);
  return unit >= 0x80 && code < 0x80 ? unit : code;
}

function unitsLike(unit: number): number[] {
  if (!caseUnits) {
    caseUnits = new Map();
    for (let u = 0; u < UNITS; u++) {
      const canon = canonicalUnit(u);
      const units = caseUnits.get(canon);
      if (units) units.push(u);
      else caseUnits.set(canon, [u]);
    }
  }
  return caseUnits.get(canonicalUnit(unit)) ?? [unit];
}

/** Literal automata, kept per text so each is built once. */
const literalAutomata = new Map<string, Automaton>();

/** An automaton for `text` as written, case aside, as `notePattern` reads it. */
function literalAutomaton(text: string): Automaton {
  const cached = literalAutomata.get(text);
  if (cached) return cached;
  const positions = Array.from({ length: text.length }, (_, i) => unitsLike(text.charCodeAt(i)));
  const units = [...new Set(positions.flat())].sort((a, b) => a - b);
  const classStarts = [0];
  for (const unit of units) {
    if (classStarts.at(-1) !== unit) classStarts.push(unit);
    if (unit + 1 < UNITS) classStarts.push(unit + 1);
  }
  const classOfUnit = (unit: number) => classStarts.indexOf(unit);
  const charsets = positions.map((like) => like.map(classOfUnit));
  const nodes = [...positions.map((_, i) => [0, 0, i + 1, i]), [0, 1]];
  const automaton = compile({ classStarts, charsets, initials: [0], leads: [-1], nodes });
  literalAutomata.set(text, automaton);
  return automaton;
}

/** The first edges of the given patterns, per character class. */
function startEdges(automaton: Automaton, patterns: readonly number[]): Int32Array[] {
  const classCount = automaton.has[0]?.length ?? 0;
  const byClass: number[][] = Array.from({ length: classCount }, () => []);
  for (const p of patterns) {
    const e = automaton.edges[automaton.initials[p] as number] as Int32Array;
    for (let i = 0; i < e.length; i += 2) {
      const set = automaton.has[e[i + 1] as number] as Uint8Array;
      for (let k = 0; k < classCount; k++) if (set[k]) byClass[k]?.push(e[i] as number);
    }
  }
  return byClass.map((targets) => Int32Array.from(targets));
}

/**
 * Text grown at its end, with what its latest update added. Reading a grown
 * string copies the whole of it, so what reads each new character reads it
 * from `fresh`.
 */
interface Grown {
  text: string;
  fresh: string;
}

function grow(target: Grown, piece: string): void {
  target.text += piece;
  target.fresh += piece;
}

/** Where `fresh` starts in `text`. */
function freshFrom(source: Grown): number {
  return source.text.length - source.fresh.length;
}

function unitAt(source: Grown, at: number): number {
  const base = freshFrom(source);
  return at >= base ? source.fresh.charCodeAt(at - base) : source.text.charCodeAt(at);
}

function sliceOf(source: Grown, from: number, to: number = source.text.length): string {
  const base = freshFrom(source);
  return from >= base ? source.fresh.slice(from - base, to - base) : source.text.slice(from, to);
}

/**
 * A rewrite of the reply, grown as the reply is: its settled text (no later
 * reply text changes it) and, per settled character, the reply index a match
 * starting there must be held from.
 */
interface View extends Grown {
  /** Reply index to hold from for a match starting at view index `j`. */
  rawAt: (j: number) => number;
  /** Take whatever the source has settled since the last call. */
  update: () => void;
}

/** The reply itself. */
function rawView(reply: Grown): View {
  const view: View = {
    text: '',
    fresh: '',
    rawAt: (j) => j,
    update() {
      view.text = reply.text;
      view.fresh = reply.fresh;
    },
  };
  return view;
}

/** A rewrite of each UTF-16 unit on its own (rot13, leet): settled as soon as read. */
function unitView(source: View, rewrite: (text: string) => string): View {
  const view: View = {
    text: '',
    fresh: '',
    rawAt: source.rawAt,
    update() {
      view.fresh = '';
      grow(view, rewrite(sliceOf(source, view.text.length)));
    },
  };
  return view;
}

const WORD_UNIT = /\w/;
const MAX_TARGET = Math.max(...TYPO_TARGETS.map((target) => target.length));

/** Whether a word still being written could yet fold to a typo target: a misspelling may be a letter longer. */
function mayFold(run: string): boolean {
  return run.length <= MAX_TARGET + 1 && /^[A-Za-z]*$/.test(run);
}

/**
 * `typoNormalize` of the source. It rewrites whole words (`\w` runs), so a
 * word settles when a non-word character ends it, or as soon as it can no
 * longer fold to a target (then the rest of it passes as is). A corrected word
 * may be a letter longer or shorter than the word as written, so each
 * character keeps the source index it stands for.
 */
function typoView(source: View): View {
  let read = 0;
  /** The word being read, while it may still fold. */
  let word: string | undefined;
  let inWord = false;
  /** Per settled character, the source index it stands for. */
  const from: number[] = [];
  const put = (piece: string, start: number, length: number) => {
    grow(view, piece);
    for (let i = 0; i < piece.length; i++) from.push(start + Math.min(i, length - 1));
  };
  const view: View = {
    text: '',
    fresh: '',
    rawAt: (j) => source.rawAt(j < from.length ? (from[j] as number) : read - (word?.length ?? 0)),
    update() {
      view.fresh = '';
      for (const end = source.text.length; read < end; read++) {
        const unit = String.fromCharCode(unitAt(source, read));
        const wordUnit = WORD_UNIT.test(unit);
        if (wordUnit && !inWord) word = '';
        inWord = wordUnit;
        if (!wordUnit) {
          if (word !== undefined) put(typoNormalize(word), read - word.length, word.length);
          word = undefined;
          put(unit, read, 1);
        } else if (word === undefined) put(unit, read, 1);
        else word += unit;
      }
      if (word !== undefined && !mayFold(word)) {
        put(word, read - word.length, word.length);
        word = undefined;
      }
    },
  };
  return view;
}

/** A rewrite whose characters keep their own reply index. */
interface MappedView extends View {
  from: number[];
}

function mappedView(pendingAt: () => number): MappedView {
  const view: MappedView = {
    text: '',
    fresh: '',
    from: [],
    rawAt: (j) => (j < view.from.length ? (view.from[j] as number) : pendingAt()),
    update() {},
  };
  return view;
}

function append(view: MappedView, text: string, from: number): void {
  grow(view, text);
  for (let i = 0; i < text.length; i++) view.from.push(from);
}

const HIGH_LO = 0xd800;
const HIGH_HI = 0xdbff;
const ASCII_LETTER = /[A-Za-z]/;

const LOW_LO = 0xdc00;
const LOW_HI = 0xdfff;

/**
 * `normalizeForDetection` of the reply, in its three passes: each code point
 * mapped, emoji runs between letters dropped, a backslash before a letter
 * dropped. Unsettled: a high surrogate whose low half may follow (in the reply
 * or in the mapped text), an emoji run after a letter until the character
 * after it, a backslash until the character after it.
 */
function normalizedView(reply: Grown): MappedView {
  let read = 0;
  /** Mapped text the emoji pass has not read: at most a trailing high surrogate. */
  let mapped = '';
  let mappedFrom: number[] = [];
  /** The emoji run after a letter, waiting on the character after it. */
  let run = '';
  let runFrom: number[] = [];
  let afterLetter = false;
  /** A backslash waiting on the character after it: its reply index, or -1. */
  let slashFrom = -1;
  const pendingAt = (): number =>
    Math.min(read, mappedFrom[0] ?? read, runFrom[0] ?? read, slashFrom < 0 ? read : slashFrom);
  const view = mappedView(pendingAt);

  function backslashPass(unit: string, from: number): void {
    if (slashFrom >= 0) {
      if (!ASCII_LETTER.test(unit)) append(view, '\\', slashFrom);
      slashFrom = -1;
    }
    if (unit === '\\') slashFrom = from;
    else append(view, unit, from);
  }

  function emojiPass(point: string, from: number): void {
    if (isEmoji(point) && (afterLetter || run)) {
      run += point;
      for (let i = 0; i < point.length; i++) runFrom.push(from);
      return;
    }
    if (run) {
      if (!ASCII_LETTER.test(point)) {
        for (let i = 0; i < run.length; i++) backslashPass(run[i] as string, runFrom[i] as number);
      }
      run = '';
      runFrom = [];
    }
    for (let i = 0; i < point.length; i++) backslashPass(point[i] as string, from);
    afterLetter = ASCII_LETTER.test(point) && point.length === 1;
  }

  /** Feed the mapped text to the emoji pass by code point, keeping a high surrogate at the end. */
  function drainMapped(): void {
    let i = 0;
    while (i < mapped.length) {
      const code = mapped.charCodeAt(i);
      const high = code >= HIGH_LO && code <= HIGH_HI;
      if (high && i + 1 >= mapped.length) break;
      const low = mapped.charCodeAt(i + 1);
      const width = high && low >= LOW_LO && low <= LOW_HI ? 2 : 1;
      emojiPass(mapped.slice(i, i + width), mappedFrom[i] as number);
      i += width;
    }
    mapped = mapped.slice(i);
    mappedFrom = mappedFrom.slice(i);
  }

  view.update = () => {
    view.fresh = '';
    const end = reply.text.length;
    while (read < end) {
      const code = unitAt(reply, read);
      const high = code >= HIGH_LO && code <= HIGH_HI;
      if (high && read + 1 >= end) break;
      const low = unitAt(reply, read + 1);
      const width = high && low >= LOW_LO && low <= LOW_HI ? 2 : 1;
      const out = normalizeCodePoint(sliceOf(reply, read, read + width));
      mapped += out;
      for (let i = 0; i < out.length; i++) mappedFrom.push(read);
      read += width;
    }
    drainMapped();
  };

  return view;
}

const URL_HEX = /[0-9A-Fa-f]/;

/**
 * `decodeUrlRuns` of the reply: a run of `%XX` escapes is unsettled until the
 * character after it shows the run is over. Its decoded text holds from the
 * run's first `%`.
 */
function urlView(reply: Grown): MappedView {
  let read = 0;
  /** Where the escape run being read starts, or -1. */
  let runStart = -1;
  const view = mappedView(() => (runStart < 0 ? read : runStart));
  view.update = () => {
    view.fresh = '';
    const end = reply.text.length;
    while (read < end) {
      const unit = String.fromCharCode(unitAt(reply, read));
      if (runStart < 0) {
        if (unit === '%') {
          runStart = read;
        } else {
          append(view, unit, read);
          read++;
        }
        continue;
      }
      // why: Inside a run: complete escapes end at runStart + 3k.
      const offset = (read - runStart) % 3;
      const fits = offset === 0 ? unit === '%' : URL_HEX.test(unit);
      if (fits) {
        read++;
        continue;
      }
      endRun(read - offset);
      // why: The broken escape's text is literal; `read` rereads from its end.
      for (let i = read - offset; i < read; i++)
        append(view, String.fromCharCode(unitAt(reply, i)), i);
    }
  };

  function endRun(end: number): void {
    if (end > runStart) append(view, decodeUrlRuns(sliceOf(reply, runStart, end)), runStart);
    runStart = -1;
  }

  return view;
}

interface ScanPattern {
  rule: string;
  severity: Severity;
  detector?: Detector;
  /** The automaton's id for the pattern. */
  id: number;
  regex: RegExp;
  /** Whether a settled match at `at` counts, read with the reply as the view holds it so far. */
  hit?: (match: string, reply: string, at: number) => boolean;
  /** In place of the regex: where the first hit starting in a settled stretch [from, to) starts. */
  find?: (reply: string, from: number, to: number) => number | undefined;
}

const INJECTION_KINDS: ReadonlySet<EgressPatternKind> = new Set([
  'injection',
  'base64',
  'hex',
  'spaced',
  'pipe',
]);

const BLOB_HITS = new Map(INJECTION_BLOBS.map(({ pattern, hit }) => [pattern, hit]));
const SENSITIVE_HITS = new Map(
  SENSITIVE_PATTERNS.flatMap(({ pattern, hit }) => (hit ? [[pattern, hit] as const] : [])),
);

type PatternRule = Pick<ScanPattern, 'rule' | 'severity' | 'detector'>;

/** What a match of `detector` reports, with `detectAt`'s severity. */
function detectorRule(detector: Detector): PatternRule {
  return { rule: DETECT_RULES[detector], severity: 'high', detector };
}

const INJECTION_RULE = detectorRule('injection');
const MARKER_RULE = detectorRule('marker_leak');

/** What a pattern's match reports: its detector's rule. */
function patternRule({ kind, group }: EgressPattern): PatternRule | undefined {
  if (INJECTION_KINDS.has(kind)) return INJECTION_RULE;
  switch (kind) {
    case 'sensitive':
    case 'card':
      return group === undefined ? undefined : detectorRule(group);
    case 'boundary':
      return MARKER_RULE;
    case 'image':
      return detectorRule('ungiven_images');
    default:
      return detectorRule('ungiven_links');
  }
}

interface UrlReadings {
  image: UrlPatternReading[];
  link: UrlPatternReading[];
}

/** How a settled match of `pattern` is read: a test of the match, or a finder in place of the regex. */
function patternReading(
  kind: EgressPatternKind,
  pattern: RegExp,
  urls: UrlReadings,
): Pick<ScanPattern, 'hit' | 'find'> {
  if (kind === 'card') return { hit: cardHit };
  if (kind === 'image' || kind === 'link') {
    const index = (kind === 'image' ? IMAGE_PATTERNS : LINK_PATTERNS).indexOf(pattern);
    const reading = urls[kind][index] as UrlPatternReading;
    return 'find' in reading ? { find: reading.find } : { hit: reading.test };
  }
  const hit = BLOB_HITS.get(pattern) ?? SENSITIVE_HITS.get(pattern);
  return hit ? { hit } : {};
}

/** The patterns of `detectors`, read on the reply as written. */
function forwardPatterns(
  detectors: readonly Detector[],
  { given, allow, skipImages }: Pick<EgressStreamOptions, 'given' | 'allow' | 'skipImages'>,
): ScanPattern[] {
  const scope = (check: object | undefined) => ({ ...check, ...(given ? { given } : {}) });
  const urls: UrlReadings = {
    image: imageReadings(scope(allow?.ungiven_images)),
    link: linkReadings(
      scope(allow?.ungiven_links),
      skipImages ?? detectors.includes('ungiven_images'),
    ),
  };
  const out: ScanPattern[] = [];
  EGRESS_PATTERNS.forEach((entry, id) => {
    const rule = patternRule(entry);
    if (!(rule?.detector && detectors.includes(rule.detector))) return;
    out.push({
      ...rule,
      id,
      regex: new RegExp(entry.pattern.source, entry.pattern.flags),
      ...patternReading(entry.kind, entry.pattern, urls),
    });
  });
  return out;
}

/** The injection patterns, for the rewritten views. */
function injectionPatterns(): ScanPattern[] {
  const out: ScanPattern[] = [];
  EGRESS_PATTERNS.forEach(({ kind, pattern }, id) => {
    if (kind !== 'injection') return;
    const hit = BLOB_HITS.get(pattern);
    out.push({
      ...INJECTION_RULE,
      id,
      regex: new RegExp(pattern.source, pattern.flags),
      ...(hit ? { hit } : {}),
    });
  });
  return out;
}

function reversedPatterns(): ScanPattern[] {
  return REVERSED_INJECTION_PATTERNS.map((pattern, id) => ({
    ...INJECTION_RULE,
    id,
    regex: new RegExp(pattern.source, pattern.flags),
  }));
}

/**
 * One view scanned for some patterns: the automata, run one character at a
 * time, give where each pattern could still be matching; the pattern's own
 * regex, run only where the automaton reached a match, finds the match and
 * whether it has settled. A pattern opened by an optional repeat of one class
 * has no thread for the repeat: a thread of it starts where the run of that
 * class it is in started, and the run the text ends in is still under way.
 * A pattern whose matches nest (tags inside tags) is
 * read instead by its finder, once over each stretch that settles.
 */
function createScan(view: View, automaton: Automaton, patterns: ScanPattern[]) {
  const starts = startEdges(
    automaton,
    patterns.map((p) => p.id),
  );
  const local = new Int32Array(automaton.initials.length).fill(-1);
  patterns.forEach((p, i) => {
    local[p.id] = i;
  });
  let nodes = new Int32Array(automaton.size);
  let from = new Int32Array(automaton.size);
  let next = new Int32Array(automaton.size);
  let nextFrom = new Int32Array(automaton.size);
  let count = 0;
  const slot = new Int32Array(automaton.size);
  const mark = new Int32Array(automaton.size);
  let step = 0;
  let fed = 0;
  const reached = new Uint8Array(patterns.length);
  /** Whether the regex must look again: a match of it was unsettled, or its automaton sat on a final state. */
  const recheck = new Uint8Array(patterns.length);
  const resume = new Int32Array(patterns.length);
  const liveFrom = new Int32Array(patterns.length);
  const atFinal = new Uint8Array(patterns.length);
  const finds = Uint8Array.from(patterns, (p) => (p.find ? 1 : 0));
  /**
   * Per finder: where its automaton first started a thread since the finder
   * last read, or -1. A construct starts where a thread does, so a stretch
   * with none needs no read; skipping it keeps a reply with no constructs from
   * being reread whole at every step.
   */
  const openedFrom = new Int32Array(patterns.length).fill(-1);
  const lastOpened = new Int32Array(patterns.length).fill(-1);
  const leadOf = Int32Array.from(patterns, (p) => automaton.leads[p.id] ?? -1);
  const leads = [...new Set(leadOf)].filter((lead) => lead >= 0);
  const led = patterns.flatMap((_, p) => ((leadOf[p] as number) < 0 ? [] : [p]));
  /** Per lead charset: where the run of it the text ends in started, or -1. */
  const runFrom = new Int32Array(automaton.has.length).fill(-1);

  function feed(): void {
    const { text, fresh } = view;
    const base = freshFrom(view);
    const { classOf, has, edges, final, pattern } = automaton;
    for (; fed < text.length; fed++) {
      const code = fed >= base ? fresh.charCodeAt(fed - base) : text.charCodeAt(fed);
      const cls = classOf[code] as number;
      step++;
      let size = 0;
      const add = (target: number, start: number): void => {
        if (mark[target] === step) {
          const at = slot[target] as number;
          if (start < (nextFrom[at] as number)) nextFrom[at] = start;
          return;
        }
        mark[target] = step;
        slot[target] = size;
        next[size] = target;
        nextFrom[size] = start;
        size++;
        if (final[target]) reached[local[pattern[target] as number] as number] = 1;
      };
      for (let i = 0; i < count; i++) {
        const e = edges[nodes[i] as number] as Int32Array;
        const start = from[i] as number;
        for (let k = 0; k < e.length; k += 2) {
          if ((has[e[k + 1] as number] as Uint8Array)[cls]) add(e[k] as number, start);
        }
      }
      const first = starts[cls] as Int32Array;
      for (let k = 0; k < first.length; k++) {
        const target = first[k] as number;
        const p = local[pattern[target] as number] as number;
        const lead = leadOf[p] as number;
        const run = lead < 0 ? -1 : (runFrom[lead] as number);
        const start = run < 0 ? fed : run;
        add(target, start);
        if (finds[p]) {
          lastOpened[p] = fed;
          if ((openedFrom[p] as number) < 0) openedFrom[p] = start;
        }
      }
      for (const lead of leads) {
        if (!(has[lead] as Uint8Array)[cls]) runFrom[lead] = -1;
        else if ((runFrom[lead] as number) < 0) runFrom[lead] = fed;
      }
      [nodes, next] = [next, nodes];
      [from, nextFrom] = [nextFrom, from];
      count = size;
    }
  }

  /** Per pattern: the earliest start still under way, and whether it sits on a final state. */
  function live(): number {
    const end = view.text.length;
    liveFrom.fill(end);
    atFinal.fill(0);
    let earliest = end;
    for (let i = 0; i < count; i++) {
      const node = nodes[i] as number;
      const p = local[automaton.pattern[node] as number] as number;
      const start = from[i] as number;
      if (start < (liveFrom[p] as number)) liveFrom[p] = start;
      if (automaton.final[node]) atFinal[p] = 1;
      if (start < earliest) earliest = start;
    }
    for (const p of led) {
      const run = runFrom[leadOf[p] as number] as number;
      if (run < 0) continue;
      if (run < (liveFrom[p] as number)) liveFrom[p] = run;
      if (run < earliest) earliest = run;
    }
    return earliest;
  }

  /** A finder's hit up to `settledTo`, run only on a stretch its automaton opened a thread in. */
  function found(p: number, settledTo: number): EgressStreamHit | undefined {
    const opened = openedFrom[p] as number;
    const from = resume[p] as number;
    if (opened < 0 || opened >= settledTo) {
      resume[p] = settledTo;
      return undefined;
    }
    const { find, rule, severity, detector } = patterns[p] as ScanPattern;
    const at = find?.(view.text, from, settledTo);
    if (at === undefined) {
      resume[p] = settledTo;
      openedFrom[p] = (lastOpened[p] as number) >= settledTo ? settledTo : -1;
      return undefined;
    }
    // why: A detector's match need not end the reply, so the next call finds the one after it.
    resume[p] = Math.max(from, at) + 1;
    return { rule, severity, start: view.rawAt(at), ...(detector ? { detector } : {}) };
  }

  /** A regex pattern's hit up to `settledTo`. */
  function matched(p: number, settledTo: number): EgressStreamHit | undefined {
    if (!reached[p] && !recheck[p]) {
      resume[p] = settledTo;
      return undefined;
    }
    reached[p] = 0;
    const text = view.text;
    const { regex, hit, rule, severity, detector } = patterns[p] as ScanPattern;
    regex.lastIndex = resume[p] as number;
    for (;;) {
      const match = regex.exec(text);
      if (!match || match.index >= settledTo) {
        resume[p] = settledTo;
        recheck[p] = match || atFinal[p] ? 1 : 0;
        return undefined;
      }
      const [blob] = match;
      if (blob && (!hit || hit(blob, text, match.index))) {
        // why: The scan reads on from the end of the match, so the next call finds the one after it.
        resume[p] = regex.lastIndex;
        recheck[p] = 1;
        return {
          rule,
          severity,
          start: view.rawAt(match.index),
          ...(detector ? { detector } : {}),
        };
      }
      if (!blob) regex.lastIndex++;
      resume[p] = regex.lastIndex;
    }
  }

  function detect(): EgressStreamHit | undefined {
    for (let p = 0; p < patterns.length; p++) {
      const settledTo = liveFrom[p] as number;
      if (settledTo <= (resume[p] as number)) continue;
      const hit = (patterns[p] as ScanPattern).find ? found(p, settledTo) : matched(p, settledTo);
      if (hit) return hit;
    }
    return undefined;
  }

  return {
    /** Read what the view settled into `hits`; the reply index to hold from. */
    run(hits: EgressStreamHit[]): number {
      feed();
      const earliest = live();
      for (let hit = detect(); hit; hit = detect()) {
        hits.push(hit);
        // why: A match of a host rule blocks, so nothing after it is read.
        if (!hit.detector) break;
      }
      return view.rawAt(earliest);
    },
  };
}

interface EgressStreamOptions {
  /** The detectors whose matches the stream settles. Default none. */
  detect?: readonly Detector[];
  /** What `ungiven_images` and `ungiven_links` let through besides the given URLs. */
  allow?: ResolvedAllow;
  /**
   * Whether `ungiven_links` leaves an image's own markup alone. Default: `ungiven_images` is
   * among `detect`. Set when another reader has the images.
   */
  skipImages?: boolean;
  /** Host rules, read on the reply as written, with their compiled automaton. */
  host?: {
    automaton: EgressAutomatonData;
    rules: readonly { rule: string; severity: Severity; pattern: RegExp }[];
  };
  /** The URLs the model was given, for `ungiven_images` and `ungiven_links`. */
  given?: GivenUrls;
  /** The words of the profile's own canary note, for `marker_leak` (`boundaryNote`). */
  note?: string;
}

/** Compiled host automata, kept per table so each is built once. */
const hostAutomata = new WeakMap<EgressAutomatonData, Automaton>();

function hostPatterns({ rules }: NonNullable<EgressStreamOptions['host']>): ScanPattern[] {
  return rules.map(({ rule, severity, pattern }, id) => ({
    rule,
    severity,
    id,
    regex: globalPattern(pattern),
  }));
}

/** Scans the detectors' patterns and any host rules, as a reply streams. */
function createEgressStream(options: EgressStreamOptions = {}): EgressStream {
  const reply: Grown = { text: '', fresh: '' };
  const raw = rawView(reply);
  const views: View[] = [raw];
  const scan = (view: View, automaton: Automaton, patterns: ScanPattern[]) => {
    if (!views.includes(view)) views.push(view);
    return createScan(view, automaton, patterns);
  };
  const scans: ReturnType<typeof createScan>[] = [];
  const detectors = options.detect ?? [];
  const forwardScan = forwardPatterns(detectors, options);
  if (forwardScan.length > 0) {
    forward ??= compile(FORWARD_AUTOMATON);
    scans.push(scan(raw, forward, forwardScan));
  }
  if (detectors.includes('injection')) {
    forward ??= compile(FORWARD_AUTOMATON);
    backward ??= compile(REVERSED_AUTOMATON);
    const normalized = normalizedView(reply);
    const injection = injectionPatterns();
    scans.push(
      scan(raw, backward, reversedPatterns()),
      scan(typoView(raw), forward, injection),
      scan(normalized, forward, injection),
      scan(typoView(normalized), forward, injection),
      scan(unitView(raw, tryRot13), forward, injection),
      scan(
        unitView(raw, (text) => tryLeet(text) ?? text),
        forward,
        injection,
      ),
      scan(urlView(reply), forward, injection),
    );
  }
  if (detectors.includes('marker_leak') && options.note) {
    const regex = notePattern(options.note);
    scans.push(scan(raw, literalAutomaton(options.note), [{ ...MARKER_RULE, id: 0, regex }]));
  }
  if (options.host) {
    let automaton = hostAutomata.get(options.host.automaton);
    if (!automaton) {
      automaton = compile(options.host.automaton);
      hostAutomata.set(options.host.automaton, automaton);
    }
    scans.push(scan(raw, automaton, hostPatterns(options.host)));
  }
  let hold = 0;
  return {
    push(chunk) {
      reply.text += chunk;
      reply.fresh = chunk;
      for (const view of views) view.update();
      const hits: EgressStreamHit[] = [];
      let from = reply.text.length;
      for (const s of scans) {
        from = Math.min(from, s.run(hits));
        if (hits.some(({ detector }) => !detector)) return hits;
      }
      hold = from;
      return hits;
    },
    holdFrom: () => hold,
  };
}

/** A stream running a policy's checks, for the turn or session `context` describes. */
type EgressStreamPlan = (context: GuardrailContext) => EgressStream;

/** Streaming plans for the policies whose checks the stream runs itself. */
const STREAM_PLANS = new WeakMap<EgressEnforcer, EgressStreamPlan>();

/** The streaming plan for `enforce`, when the stream knows its checks. */
function streamPlanOf(enforce: EgressEnforcer): EgressStreamPlan | undefined {
  return STREAM_PLANS.get(enforce);
}

/** Tell the gate `enforce` runs exactly the checks `plan` streams. */
function registerStreamPlan(enforce: EgressEnforcer, plan: EgressStreamPlan): void {
  STREAM_PLANS.set(enforce, plan);
}

export type {
  EgressStream,
  EgressStreamHit,
  EgressStreamOptions,
  EgressStreamPlan,
  Grown,
  MappedView,
  View,
};
export { createEgressStream, normalizedView, registerStreamPlan, streamPlanOf, typoView, urlView };
