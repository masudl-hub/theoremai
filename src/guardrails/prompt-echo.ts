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
 * the canary, any one word, or none continues a run: a model told to hide the
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
    for (const each of read.plain) readings.plain.push(each);
    for (const each of read.slotted) readings.slotted.push(each);
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

/** Between two readings in `PromptWords`: no run reaches across it. */
const BREAK = '\u0001';

/** The prompt's words as they stand: a run is looked for in them when a reply is read. */
interface PromptWords {
  /** Every reading, word by word, with a `BREAK` after each. */
  plain: string[];
  /** Where each word stands in `plain`. */
  places: Map<string, number[]>;
  /** Every reading with the canary's `SLOT`, likewise. */
  slotted: string[];
  /** Where each `SLOT` stands in `slotted`. */
  slots: number[];
  /** Every all-ASCII prefix of a word. */
  prefixes: Set<string>;
  /** The longest word, in code units. */
  longest: number;
}

function readPrompt(stretches: readonly string[], canary?: string): PromptWords {
  const readings = promptReadings(stretches, canary);
  const read: PromptWords = {
    plain: readings.plain.flatMap((words) => [...words, BREAK]),
    places: new Map(),
    slotted: readings.slotted.flatMap((words) => [...words, BREAK]),
    slots: [],
    prefixes: new Set(),
    longest: 0,
  };
  for (const [at, word] of read.plain.entries()) {
    if (word === BREAK) continue;
    const places = read.places.get(word);
    if (places) {
      places.push(at);
      continue;
    }
    read.places.set(word, [at]);
    read.longest = Math.max(read.longest, word.length);
    for (let end = 1; end <= word.length && ASCII.test(word.charAt(end - 1)); end++) {
      read.prefixes.add(word.slice(0, end));
    }
  }
  for (const [at, word] of read.slotted.entries()) {
    if (word === SLOT) read.slots.push(at);
  }
  return read;
}

/** Whether a reading has `run` word for word, looked for from its word the prompt has least. */
function hasRun(read: PromptWords, run: readonly string[]): boolean {
  let fewest: number[] | undefined;
  let anchor = 0;
  for (const [k, word] of run.entries()) {
    const places = read.places.get(word);
    if (!places) return false;
    if (!fewest || places.length < fewest.length) {
      fewest = places;
      anchor = k;
    }
  }
  return (fewest ?? []).some((at) => run.every((word, k) => read.plain[at - anchor + k] === word));
}

/**
 * Where in `run` the canary's place fell when the prompt has it: -1 for
 * nowhere, undefined when not a run. A run may not start on the canary's place
 * unless `leading`: a stand-in for it is not prompt text.
 */
function matchRun(read: PromptWords, run: readonly string[], leading: boolean): number | undefined {
  if (hasRun(read, run)) return -1;
  for (const at of read.slots) {
    for (let slot = run.length - 1; slot >= (leading ? 0 : 1); slot--) {
      const from = at - slot;
      if (run.every((word, k) => k === slot || read.slotted[from + k] === word)) return slot;
    }
  }
  return undefined;
}

const readings = new WeakMap<readonly string[], Map<string | undefined, PromptWords>>();

/** `stretches` read once for as long as they live: each turn holds its own, so overlapping turns never rebuild each other's. */
function promptWords(stretches: readonly string[], canary?: string): PromptWords {
  const byCanary = readings.get(stretches) ?? new Map<string | undefined, PromptWords>();
  readings.set(stretches, byCanary);
  const read = byCanary.get(canary) ?? readPrompt(stretches, canary);
  byCanary.set(canary, read);
  return read;
}

/**
 * Whether a word still being written could end as a word of the system
 * prompt. ASCII folds letter by letter, so it must start one; other
 * scripts can fold several letters into one (Hangul jamo, up to three), so
 * only a word too long to fold down to any of them is ruled out.
 */
function mayBecomePromptWord(partial: string, read: PromptWords): boolean {
  if (ASCII.test(partial)) {
    return read.prefixes.has(partial.toLowerCase());
  }
  return partial.length <= MAX_FOLD * read.longest;
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
  const read = promptWords(stretches, canary);
  const hold = mayBecomePromptWord(text.slice(writing), read) ? writing : text.length;
  for (
    let from = Math.max(0, complete.length - (PROMPT_ECHO_WORDS - 1));
    from < complete.length;
    from++
  ) {
    const run = complete.slice(from).map((entry) => entry.word);
    if (matchRun(read, run, false) !== undefined) {
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
  const read = promptWords(stretches, canary);
  const words = echoWords(text);
  const ranges: Array<[number, number]> = [];
  // why: A run holds no word the prompt lacks but the canary's stand-in, so a window with more is skipped unread.
  const strange = read.slots.length > 0 ? 1 : 0;
  const foreign = words.map((entry) => (read.places.has(entry.word) ? 0 : 1));
  let outside = foreign.slice(0, PROMPT_ECHO_WORDS - 1).reduce((sum: number, n) => sum + n, 0);
  for (let from = 0; from + PROMPT_ECHO_WORDS <= words.length; from++) {
    outside += foreign[from + PROMPT_ECHO_WORDS - 1] as number;
    if (from > 0) outside -= foreign[from - 1] as number;
    if (outside > strange) continue;
    const run = words.slice(from, from + PROMPT_ECHO_WORDS).map((entry) => entry.word);
    const slot = matchRun(read, run, true);
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
