/**
 * System-prompt echo — the leak the canary cannot see.
 *
 * The canary proves the token leaked; a reply that restates the system prompt
 * while leaving the token out trips nothing. This check reads the reply for a
 * run of `PROMPT_ECHO_WORDS` consecutive words of one private stretch of the
 * system prompt (`BoundSystem.private`); text the host marked shareable is
 * not read, and no run reaches across it. Words are
 * compared case-folded after Unicode compatibility folding, punctuation and
 * markup between them ignored, and bare numbers skipped, so reformatting a
 * dump as a numbered or bulleted list does not hide it. Nor does encoding it:
 * the prompt is also read backwards and in rot13, and both it and the reply
 * with leetspeak decoded. Where the prompt has
 * the canary, any one word or none continues a run: a model told to hide the
 * canary echoes the prompt around a stand-in for it. A streamed reply holds
 * the words an echo could still grow from (`promptEchoHoldFrom`), so none of
 * an echo reaches the host.
 *
 * @module
 */

import { LEET_MAP, tryRot13 } from './injection.ts';

/** Consecutive system-prompt words that make a reply an echo of it. */
const PROMPT_ECHO_WORDS = 12;
/** Words a scan rereads before new text: an echo run ending in it starts no earlier. */
const ECHO_LOOKBACK_WORDS = PROMPT_ECHO_WORDS;

const WORD = /[\p{L}\p{N}]+/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const NUMBER = /^\p{N}+$/u;
const ASCII = /^\p{ASCII}*$/u;
/** Most letters compatibility folding joins into one (a Hangul syllable from its jamo). */
const MAX_FOLD = 3;

interface EchoWord {
  word: string;
  at: number;
  to: number;
}

/** The words a text is compared by, with the offsets each came from. */
function echoWords(text: string): EchoWord[] {
  const words: EchoWord[] = [];
  for (const match of text.matchAll(WORD)) {
    const word = match[0].normalize('NFKC').toLowerCase();
    if (!NUMBER.test(word)) {
      words.push({ word, at: match.index, to: match.index + match[0].length });
    }
  }
  return words;
}

/** Where the canary stood in the prompt's words: any one word or none matches it. */
const SLOT = '\u0000';

interface PromptReadings {
  /** Each stretch's words as written, and with the canary left out where it has one. */
  plain: string[][];
  /** Each stretch with the canary, its words with the canary as `SLOT`. */
  slotted: string[][];
}

/**
 * The prompt as a reply can encode it: written backwards, by code point, in
 * rot13, or as the decoded leetspeak reply reads it.
 */
const PROMPT_VIEWS: ReadonlyArray<(text: string) => string> = [
  (text) => text,
  (text) => [...text].reverse().join(''),
  tryRot13,
  decodeLeet,
];

/**
 * The private stretches' words as a run can repeat them, in each of
 * `PROMPT_VIEWS`: as written, with the canary left out, and with the canary
 * as `SLOT`.
 */
function promptReadings(stretches: readonly string[], canary?: string): PromptReadings {
  const readings: PromptReadings = { plain: [], slotted: [] };
  for (const view of PROMPT_VIEWS) {
    const read = viewReadings(stretches.map(view), canary === undefined ? undefined : view(canary));
    readings.plain.push(...read.plain);
    readings.slotted.push(...read.slotted);
  }
  return readings;
}

function viewReadings(stretches: readonly string[], canary?: string): PromptReadings {
  const token = canary ? echoWords(canary).map((entry) => entry.word) : [];
  const readings: PromptReadings = { plain: [], slotted: [] };
  for (const stretch of stretches) {
    const words = echoWords(stretch).map((entry) => entry.word);
    readings.plain.push(words);
    if (token.length === 0) continue;
    const slotted: string[] = [];
    for (let at = 0; at < words.length; ) {
      if (token.every((word, k) => words[at + k] === word)) {
        slotted.push(SLOT);
        at += token.length;
      } else {
        slotted.push(words[at] as string);
        at++;
      }
    }
    if (!slotted.includes(SLOT)) continue;
    readings.plain.push(slotted.filter((word) => word !== SLOT));
    readings.slotted.push(slotted);
  }
  return readings;
}

/** A run with a slot, keyed by where the slot is and the words around it. */
function slotKey(run: readonly string[], slot: number): string {
  // why: Bare numbers are never words here, so the slot's index leads unambiguously.
  return [slot, ...run.filter((_, k) => k !== slot)].join(' ');
}

interface RunSet {
  plain: Set<string>;
  slotted: Set<string>;
  /** Where in a run the slot can stand. */
  slots: Set<number>;
}

/** A run may not start on the canary's place unless `leading`: a stand-in for it is not prompt text. */
function addRuns(set: RunSet, readings: PromptReadings, lengths: number[], leading: boolean): void {
  for (const words of readings.plain) {
    for (const length of lengths) {
      for (let from = 0; from + length <= words.length; from++) {
        set.plain.add(words.slice(from, from + length).join(' '));
      }
    }
  }
  for (const slotted of readings.slotted) {
    for (const length of lengths) {
      for (let from = 0; from + length <= slotted.length; from++) {
        const run = slotted.slice(from, from + length);
        const slot = run.indexOf(SLOT);
        if (slot === -1 || (slot === 0 && !leading)) continue;
        set.slotted.add(slotKey(run, slot));
        set.slots.add(slot);
      }
    }
  }
}

/** Where in `run` the canary's place fell when `set` has it: -1 for nowhere, undefined when not a run. */
function matchRun(set: RunSet, run: readonly string[]): number | undefined {
  if (set.plain.has(run.join(' '))) return -1;
  for (const slot of set.slots) {
    if (slot < run.length && set.slotted.has(slotKey(run, slot))) return slot;
  }
  return undefined;
}

function sameStretches(a: readonly string[], b: readonly string[]): boolean {
  return a === b || (a.length === b.length && a.every((stretch, k) => stretch === b[k]));
}

let gramsCache: { stretches: readonly string[]; canary?: string; grams: RunSet } | undefined;

/** Every run of `PROMPT_ECHO_WORDS` words in a private stretch. */
function promptGrams(stretches: readonly string[], canary?: string): RunSet {
  if (
    gramsCache &&
    gramsCache.canary === canary &&
    sameStretches(gramsCache.stretches, stretches)
  ) {
    return gramsCache.grams;
  }
  const grams: RunSet = { plain: new Set(), slotted: new Set(), slots: new Set() };
  addRuns(grams, promptReadings(stretches, canary), [PROMPT_ECHO_WORDS], true);
  gramsCache = { stretches, canary, grams };
  return grams;
}

interface PromptShape {
  /** Every run of fewer than `PROMPT_ECHO_WORDS` words. */
  runs: RunSet;
  /** Every all-ASCII prefix of a word. */
  prefixes: Set<string>;
  /** The longest word, in code units. */
  longest: number;
}

let shapeCache: { stretches: readonly string[]; canary?: string; shape: PromptShape } | undefined;

function promptShape(stretches: readonly string[], canary?: string): PromptShape {
  if (
    shapeCache &&
    shapeCache.canary === canary &&
    sameStretches(shapeCache.stretches, stretches)
  ) {
    return shapeCache.shape;
  }
  const readings = promptReadings(stretches, canary);
  const shape: PromptShape = {
    runs: { plain: new Set(), slotted: new Set(), slots: new Set() },
    prefixes: new Set(),
    longest: 0,
  };
  for (const word of readings.plain.flat()) {
    shape.longest = Math.max(shape.longest, word.length);
    for (let end = 1; end <= word.length && ASCII.test(word.charAt(end - 1)); end++) {
      shape.prefixes.add(word.slice(0, end));
    }
  }
  addRuns(
    shape.runs,
    readings,
    Array.from({ length: PROMPT_ECHO_WORDS - 1 }, (_, k) => k + 1),
    false,
  );
  shapeCache = { stretches, canary, shape };
  return shape;
}

/**
 * Whether a word still being written could end as a word of the system
 * prompt. ASCII folds letter by letter, so it must start one; other
 * scripts can fold several letters into one (Hangul jamo, up to three), so
 * only a word too long to fold down to any of them is ruled out.
 */
function mayBecomePromptWord(partial: string, shape: PromptShape): boolean {
  if (ASCII.test(partial)) {
    return shape.prefixes.has(partial.toLowerCase());
  }
  return partial.length <= MAX_FOLD * shape.longest;
}

/**
 * Where an echo still being written could start: the first word of the
 * longest run of words ending `text` that the system prompt also has, or the
 * word still being written when that is earlier and could become a prompt
 * word. Any echo that completes later starts there or after.
 */
function promptEchoHoldFrom(text: string, stretches: readonly string[], canary?: string): number {
  for (let reach = TAIL_REACH; ; reach *= 2) {
    const start = decodableFrom(text, text.length - reach);
    const holds = replyViews(text.slice(start)).map((view) => holdFrom(view, stretches, canary));
    if (start === 0 || holds.every(({ tail }) => tail > 0)) {
      return start + Math.min(...holds.map(({ hold }) => hold));
    }
  }
}

/** The hold in `text`, and where the words it was read from start: at 0, `text` may be too short a tail. */
function holdFrom(
  text: string,
  stretches: readonly string[],
  canary?: string,
): { hold: number; tail: number } {
  const tail = promptEchoScanFrom(text, text.length);
  return { hold: holdIn(text, tail, stretches, canary), tail };
}

function holdIn(text: string, tail: number, stretches: readonly string[], canary?: string): number {
  const words = echoWords(text.slice(tail));
  let writing = text.length;
  while (writing > 0 && WORD_CHAR.test(text.charAt(writing - 1))) writing--;
  const complete = words.filter(
    (entry) => tail + entry.to < text.length || writing === text.length,
  );
  const shape = promptShape(stretches, canary);
  const hold = mayBecomePromptWord(text.slice(writing), shape) ? writing : text.length;
  for (
    let from = Math.max(0, complete.length - (PROMPT_ECHO_WORDS - 1));
    from < complete.length;
    from++
  ) {
    const run = complete.slice(from).map((entry) => entry.word);
    if (matchRun(shape.runs, run) !== undefined) {
      return Math.min(hold, tail + (complete[from] as EchoWord).at);
    }
  }
  return hold;
}

/** A leetspeak letter, or a list number that stays one; `!` only before a word goes on. */
const LEET = /(?<=^|\n)[ \t]*\p{N}+[.)]|[0-9@]|!(?=[\p{L}\p{N}@])/gu;

/** How far back a tail is first read from; a tail with too few words in it is doubled. */
const TAIL_REACH = 512;
const LIST_NUMBER_CHAR = /[ \t\p{N}]/u;
const NUMBER_CHAR = /\p{N}/u;

/**
 * A start at or before `at` from which `text` decodes as it does whole: a
 * list number is one from its line's start, so the start is no later than the
 * character before the blanks and digits leading up to `at`.
 */
function decodableFrom(text: string, at: number): number {
  let start = Math.max(0, at);
  while (start > 0 && LIST_NUMBER_CHAR.test(text.charAt(start - 1))) start--;
  return Math.max(0, start - 1);
}

/** `text` with its leetspeak decoded, letter for letter, so offsets keep. */
function decodeLeet(text: string): string {
  return text.replace(LEET, (match) => (match.length === 1 ? (LEET_MAP[match] ?? match) : match));
}

/** The reply as written and with its leetspeak decoded. */
function replyViews(text: string): string[] {
  const decoded = decodeLeet(text);
  return decoded === text ? [text] : [text, decoded];
}

/** Offsets `[start, end)` of `text` that repeat a private stretch, ordered by start. */
function promptEchoRanges(
  text: string,
  stretches: readonly string[],
  canary?: string,
): Array<[number, number]> {
  return replyViews(text)
    .flatMap((view) => echoRanges(view, stretches, canary))
    .sort((a, b) => a[0] - b[0]);
}

function echoRanges(
  text: string,
  stretches: readonly string[],
  canary?: string,
): Array<[number, number]> {
  const grams = promptGrams(stretches, canary);
  if (!text || grams.plain.size === 0) {
    return [];
  }
  const words = echoWords(text);
  const ranges: Array<[number, number]> = [];
  for (let from = 0; from + PROMPT_ECHO_WORDS <= words.length; from++) {
    const run = words.slice(from, from + PROMPT_ECHO_WORDS).map((entry) => entry.word);
    const slot = matchRun(grams, run);
    if (slot === undefined) continue;
    // why: A stand-in for the canary at either end is the model's, not the prompt's.
    const first = slot === 0 ? from + 1 : from;
    const last = slot === PROMPT_ECHO_WORDS - 1 ? from + slot - 1 : from + PROMPT_ECHO_WORDS - 1;
    ranges.push([words[first]?.at ?? 0, words[last]?.to ?? 0]);
  }
  return ranges;
}

/** Whether `text` repeats `PROMPT_ECHO_WORDS` consecutive words of a private stretch. */
function scanTextForPromptEcho(
  text: string,
  stretches: readonly string[],
  canary?: string,
): boolean {
  return promptEchoRanges(text, stretches, canary).length > 0;
}

/**
 * Where a scan of `text` must start when everything before `from` was
 * already scanned clean: at the word an echo run ending past `from` could
 * start in.
 */
function promptEchoScanFrom(text: string, from: number): number {
  const end = Math.min(from, text.length);
  for (let reach = TAIL_REACH; ; reach *= 2) {
    const start = decodableFrom(text, end - reach);
    // why: What follows `end` decides how the tail's last characters read: a `!` by the next one, digits by the list number they may be.
    let stop = end;
    while (stop < text.length && NUMBER_CHAR.test(text.charAt(stop))) stop++;
    const tail = text.slice(start, stop + 1);
    const at = Math.min(...replyViews(tail).map((view) => scanFrom(view, end - start)));
    if (start === 0 || at > 0) return start + at;
  }
}

function scanFrom(text: string, from: number): number {
  let at = Math.min(from, text.length);
  for (let counted = 0; counted < ECHO_LOOKBACK_WORDS && at > 0; ) {
    while (at > 0 && !WORD_CHAR.test(text.charAt(at - 1))) at--;
    const end = at;
    while (at > 0 && WORD_CHAR.test(text.charAt(at - 1))) at--;
    if (end > at && !NUMBER.test(text.slice(at, end))) counted++;
  }
  return at;
}

export {
  PROMPT_ECHO_WORDS,
  promptEchoHoldFrom,
  promptEchoRanges,
  promptEchoScanFrom,
  scanTextForPromptEcho,
};
