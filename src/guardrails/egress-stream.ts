/**
 * The bundled egress policy, run on a reply as it streams.
 *
 * The bundled checks match their patterns on the reply as written and, for
 * injection phrasing, on
 * rewrites of it (typo-folded, Unicode-folded, rot13, leet, URL-decoded, read
 * backwards). The stream keeps each rewrite growing with the reply and, for
 * every pattern, an automaton accepting every match of it and more
 * (`egress-automata.ts`). Text is held from the earliest place any match could
 * still be under way in any rewrite, and nowhere else: a match that completes
 * later starts at or after that place, so none of it has been released.
 *
 * A match whose outcome no later text can change is settled; a settled match
 * of the pattern itself (not the automaton) is a hit, and the reply is
 * blocked there. Each character is read a bounded number of times, so a long
 * reply costs time in proportion to its length.
 *
 * @module
 */

import { DEFAULT_CHECKS, type ResolvedEgressChecks, standardEgressEnforce } from './egress.ts';
import {
  FORWARD_AUTOMATON,
  REVERSED_AUTOMATON,
  REVERSED_INJECTION_PATTERNS,
} from './egress-automata.ts';
import { EGRESS_PATTERNS, type EgressPattern, type EgressPatternKind } from './egress-patterns.ts';
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
import { EGRESS_RULES } from './rules.ts';
import { cardHit } from './sensitive.ts';
import type { EgressEnforcer, GuardrailContext, Severity } from './types.ts';

/** A settled match the policy blocks on. */
interface EgressStreamHit {
  rule: string;
  severity: Severity;
  /** Where in the reply the match starts (the start of its rewrite's source). */
  start: number;
}

interface EgressStream {
  /** Read the next piece of the reply; a hit when a match has settled. */
  push: (chunk: string) => EgressStreamHit | undefined;
  /** The earliest index of the reply a match could still start at. */
  holdFrom: () => number;
}

// ── Automata ─────────────────────────────────────────────────────────

interface Automaton {
  classOf: Uint16Array;
  /** Per charset, per class: 1 when the class is in the set. */
  has: Uint8Array[];
  pattern: Int32Array;
  final: Uint8Array;
  /** Per node: target, charset, target, charset, ... */
  edges: Int32Array[];
  initials: readonly number[];
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
  return { classOf, has, pattern, final, edges, initials: data.initials, size };
}

let forward: Automaton | undefined;
let backward: Automaton | undefined;

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

// ── Rewrites ─────────────────────────────────────────────────────────

/**
 * A rewrite of the reply, grown as the reply is: its settled text (no later
 * reply text changes it) and, per settled character, the reply index a match
 * starting there must be held from.
 */
interface View {
  text: string;
  /** Reply index to hold from for a match starting at view index `j`. */
  rawAt: (j: number) => number;
  /** Take whatever the source has settled since the last call. */
  update: () => void;
}

/** The reply itself. */
function rawView(reply: { text: string }): View {
  const view: View = {
    text: '',
    rawAt: (j) => j,
    update() {
      view.text = reply.text;
    },
  };
  return view;
}

/** A rewrite of each UTF-16 unit on its own (rot13, leet): settled as soon as read. */
function unitView(source: View, rewrite: (text: string) => string): View {
  const view: View = {
    text: '',
    rawAt: source.rawAt,
    update() {
      view.text += rewrite(source.text.slice(view.text.length));
    },
  };
  return view;
}

const WORD_UNIT = /\w/;
const MAX_TARGET = Math.max(...TYPO_TARGETS.map((target) => target.length));
const TARGET_FIRSTS = new Set(TYPO_TARGETS.map((target) => target[0]));

/** Whether a word still being written could yet fold to a typo target. */
function mayFold(run: string): boolean {
  return (
    run.length <= MAX_TARGET &&
    /^[A-Za-z]*$/.test(run) &&
    (run.length === 0 || TARGET_FIRSTS.has(run[0]?.toLowerCase()))
  );
}

/**
 * `typoNormalize` of the source. It rewrites whole words (`\w` runs) of the
 * same length, so a word settles when a non-word character ends it, or as soon
 * as it can no longer fold to a target (then the rest of it passes as is).
 */
function typoView(source: View): View {
  let read = 0;
  /** Start of the word being read, while it may still fold; -1 otherwise. */
  let wordStart = -1;
  let inWord = false;
  const view: View = {
    text: '',
    rawAt: (j) => source.rawAt(Math.min(j, view.text.length)),
    update() {
      const text = source.text;
      for (; read < text.length; read++) {
        const unit = text[read] as string;
        const wordUnit = WORD_UNIT.test(unit);
        if (wordUnit && !inWord) wordStart = read;
        inWord = wordUnit;
        if (wordUnit && wordStart < 0) {
          view.text += unit;
        } else if (!wordUnit) {
          if (wordStart >= 0) view.text += typoNormalize(text.slice(wordStart, read));
          wordStart = -1;
          view.text += unit;
        }
      }
      if (wordStart >= 0 && !mayFold(text.slice(wordStart))) {
        view.text += text.slice(wordStart);
        wordStart = -1;
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
    from: [],
    rawAt: (j) => (j < view.from.length ? (view.from[j] as number) : pendingAt()),
    update() {},
  };
  return view;
}

function append(view: MappedView, text: string, from: number): void {
  view.text += text;
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
function normalizedView(reply: { text: string }): MappedView {
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
    const text = reply.text;
    while (read < text.length) {
      const code = text.charCodeAt(read);
      const high = code >= HIGH_LO && code <= HIGH_HI;
      if (high && read + 1 >= text.length) break;
      const low = text.charCodeAt(read + 1);
      const width = high && low >= LOW_LO && low <= LOW_HI ? 2 : 1;
      const out = normalizeCodePoint(text.slice(read, read + width));
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
function urlView(reply: { text: string }): MappedView {
  let read = 0;
  /** Where the escape run being read starts, or -1. */
  let runStart = -1;
  const view = mappedView(() => (runStart < 0 ? read : runStart));
  view.update = () => {
    const text = reply.text;
    while (read < text.length) {
      if (runStart < 0) {
        if (text[read] === '%') {
          runStart = read;
        } else {
          append(view, text[read] as string, read);
          read++;
        }
        continue;
      }
      // Inside a run: complete escapes end at runStart + 3k.
      const offset = (read - runStart) % 3;
      const unit = text[read] as string;
      const fits = offset === 0 ? unit === '%' : URL_HEX.test(unit);
      if (fits) {
        read++;
        continue;
      }
      endRun(text, read - offset);
      // The broken escape's text is literal; `read` rereads from its end.
      for (let i = read - offset; i < read; i++) append(view, text[i] as string, i);
    }
  };

  function endRun(text: string, end: number): void {
    if (end > runStart) append(view, decodeUrlRuns(text.slice(runStart, end)), runStart);
    runStart = -1;
  }

  return view;
}

// ── Scans ────────────────────────────────────────────────────────────

interface ScanPattern {
  rule: string;
  severity: Severity;
  /** The automaton's id for the pattern. */
  id: number;
  regex: RegExp;
  /** Whether a settled match at `at` counts, read with the reply as the view holds it so far. */
  hit?: (match: string, reply: string, at: number) => boolean;
  /** In place of the regex: where the first hit starting in a settled stretch [from, to) starts. */
  find?: (reply: string, from: number, to: number) => number | undefined;
}

const BLOB_HITS = new Map(INJECTION_BLOBS.map(({ pattern, hit }) => [pattern, hit]));

/** The bundled rule a pattern kind trips, with `collectEgressHits`' severity. */
const KIND_RULES: Record<EgressPatternKind, { rule: string; severity: Severity }> = {
  injection: { rule: EGRESS_RULES.injection, severity: 'medium' },
  base64: { rule: EGRESS_RULES.injection, severity: 'medium' },
  hex: { rule: EGRESS_RULES.injection, severity: 'medium' },
  spaced: { rule: EGRESS_RULES.injection, severity: 'medium' },
  pipe: { rule: EGRESS_RULES.injection, severity: 'medium' },
  sensitive: { rule: EGRESS_RULES.sensitive, severity: 'high' },
  card: { rule: EGRESS_RULES.sensitive, severity: 'high' },
  boundary: { rule: EGRESS_RULES.boundary, severity: 'medium' },
  image: { rule: EGRESS_RULES.image, severity: 'high' },
  link: { rule: EGRESS_RULES.link, severity: 'high' },
};

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
  const hit = BLOB_HITS.get(pattern);
  return hit ? { hit } : {};
}

const INJECTION_KINDS: ReadonlySet<EgressPatternKind> = new Set([
  'injection',
  'base64',
  'hex',
  'spaced',
  'pipe',
]);

/** Whether `checks` runs the check a pattern belongs to. */
function runs({ kind, group }: EgressPattern, checks: ResolvedEgressChecks): boolean {
  if (INJECTION_KINDS.has(kind)) return checks.injection;
  switch (kind) {
    case 'sensitive':
    case 'card':
      return group !== undefined && checks.sensitive[group];
    case 'boundary':
      return checks.boundary;
    case 'image':
      return checks.images !== undefined;
    default:
      return checks.links !== undefined;
  }
}

/** The patterns `checks` runs on the reply as written. */
function forwardPatterns(checks: ResolvedEgressChecks, given?: GivenUrls): ScanPattern[] {
  const scope = (check: object | undefined) => ({ ...check, ...(given ? { given } : {}) });
  const urls: UrlReadings = {
    image: imageReadings(scope(checks.images)),
    link: linkReadings(scope(checks.links), checks.images !== undefined),
  };
  const out: ScanPattern[] = [];
  EGRESS_PATTERNS.forEach((entry, id) => {
    if (!runs(entry, checks)) return;
    out.push({
      ...KIND_RULES[entry.kind],
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
      ...KIND_RULES.injection,
      id,
      regex: new RegExp(pattern.source, pattern.flags),
      ...(hit ? { hit } : {}),
    });
  });
  return out;
}

function reversedPatterns(): ScanPattern[] {
  return REVERSED_INJECTION_PATTERNS.map((pattern, id) => ({
    ...KIND_RULES.injection,
    id,
    regex: new RegExp(pattern.source, pattern.flags),
  }));
}

/**
 * One view scanned for some patterns: the automata, run one character at a
 * time, give where each pattern could still be matching; the pattern's own
 * regex, run only where the automaton reached a match, finds the match and
 * whether it has settled. A pattern whose matches nest (tags inside tags) is
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

  function feed(): void {
    const text = view.text;
    const { classOf, has, edges, final, pattern } = automaton;
    for (; fed < text.length; fed++) {
      const cls = classOf[text.charCodeAt(fed)] as number;
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
      for (let k = 0; k < first.length; k++) add(first[k] as number, fed);
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
    return earliest;
  }

  function detect(): EgressStreamHit | undefined {
    const text = view.text;
    for (let p = 0; p < patterns.length; p++) {
      const settledTo = liveFrom[p] as number;
      if (settledTo <= (resume[p] as number)) continue;
      const { find } = patterns[p] as ScanPattern;
      if (find) {
        const at = find(text, resume[p] as number, settledTo);
        resume[p] = settledTo;
        if (at !== undefined) {
          const { rule, severity } = patterns[p] as ScanPattern;
          return { rule, severity, start: view.rawAt(at) };
        }
        continue;
      }
      if (!reached[p] && !recheck[p]) {
        resume[p] = settledTo;
        continue;
      }
      reached[p] = 0;
      const { regex, hit, rule, severity } = patterns[p] as ScanPattern;
      regex.lastIndex = resume[p] as number;
      for (;;) {
        const match = regex.exec(text);
        if (!match || match.index >= settledTo) {
          resume[p] = settledTo;
          recheck[p] = match || atFinal[p] ? 1 : 0;
          break;
        }
        const [blob] = match;
        if (blob && (!hit || hit(blob, text, match.index))) {
          return { rule, severity, start: view.rawAt(match.index) };
        }
        if (!blob) regex.lastIndex++;
        resume[p] = regex.lastIndex;
      }
    }
    return undefined;
  }

  return {
    /** Read what the view settled; a hit, or the reply index to hold from. */
    run(): EgressStreamHit | number {
      feed();
      const earliest = live();
      return detect() ?? view.rawAt(earliest);
    },
  };
}

// ── Stream ───────────────────────────────────────────────────────────

interface EgressStreamOptions {
  /** The bundled checks to run. Default each at its default (`EgressChecks`). */
  checks?: ResolvedEgressChecks;
  /** Host rules, read on the reply as written, with their compiled automaton. */
  host?: {
    automaton: EgressAutomatonData;
    rules: readonly { rule: string; severity: Severity; pattern: RegExp }[];
  };
  /** The URLs the model was given, for the image and link checks. */
  given?: GivenUrls;
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

/** Scans the bundled egress policy's patterns, and any host rules, as a reply streams. */
function createEgressStream(options: EgressStreamOptions = {}): EgressStream {
  const reply = { text: '' };
  const raw = rawView(reply);
  const views: View[] = [raw];
  const scan = (view: View, automaton: Automaton, patterns: ScanPattern[]) => {
    if (!views.includes(view)) views.push(view);
    return createScan(view, automaton, patterns);
  };
  const scans: ReturnType<typeof createScan>[] = [];
  const checks = options.checks ?? DEFAULT_CHECKS;
  const forwardScan = forwardPatterns(checks, options.given);
  if (forwardScan.length > 0) {
    forward ??= compile(FORWARD_AUTOMATON);
    scans.push(scan(raw, forward, forwardScan));
  }
  if (checks.injection) {
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
      for (const view of views) view.update();
      let from = reply.text.length;
      for (const s of scans) {
        const result = s.run();
        if (typeof result !== 'number') return result;
        from = Math.min(from, result);
      }
      hold = from;
      return undefined;
    },
    holdFrom: () => hold,
  };
}

/** A stream running a policy's checks, for the turn or session `context` describes. */
type EgressStreamPlan = (context: GuardrailContext) => EgressStream;

/** Streaming plans for the policies whose checks the stream runs itself. */
const STREAM_PLANS = new WeakMap<EgressEnforcer, EgressStreamPlan>([
  [
    standardEgressEnforce,
    (context) => createEgressStream(context.givenUrls ? { given: context.givenUrls } : {}),
  ],
]);

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
  MappedView,
  View,
};
export { createEgressStream, normalizedView, registerStreamPlan, streamPlanOf, typoView, urlView };
