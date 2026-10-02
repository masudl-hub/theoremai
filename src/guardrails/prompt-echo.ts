/**
 * System-prompt echo — the leak the canary cannot see.
 *
 * The canary proves the token leaked; a reply that restates the system prompt
 * while leaving the token out trips nothing. This check reads the reply for a
 * run of `PROMPT_ECHO_WORDS` consecutive words of the system prompt. Words are
 * compared case-folded after Unicode compatibility folding, punctuation and
 * markup between them ignored, and bare numbers skipped, so reformatting a
 * dump as a numbered or bulleted list does not hide it. Where the prompt has
 * the canary, any one word or none continues a run: a model told to hide the
 * canary echoes the prompt around a stand-in for it. A streamed reply holds
 * the words an echo could still grow from (`promptEchoHoldFrom`), so none of
 * an echo reaches the host.
 *
 * @module
 */

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

/**
 * The prompt's words as a run can repeat them: as written, with the canary
 * left out, and with the canary as `SLOT`.
 */
function promptReadings(
  system: string,
  canary?: string,
): { plain: string[][]; slotted?: string[] } {
  const words = echoWords(system).map((entry) => entry.word);
  const token = canary ? echoWords(canary).map((entry) => entry.word) : [];
  if (token.length === 0) return { plain: [words] };
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
  if (!slotted.includes(SLOT)) return { plain: [words] };
  return { plain: [words, slotted.filter((word) => word !== SLOT)], slotted };
}

/** A run with a slot, keyed by where the slot is and the words around it. */
function slotKey(run: readonly string[], slot: number): string {
  // Bare numbers are never words here, so the slot's index leads unambiguously.
  return [slot, ...run.filter((_, k) => k !== slot)].join(' ');
}

interface RunSet {
  plain: Set<string>;
  slotted: Set<string>;
  /** Where in a run the slot can stand. */
  slots: Set<number>;
}

/** A run may not start on the canary's place unless `leading`: a stand-in for it is not prompt text. */
function addRuns(
  set: RunSet,
  readings: ReturnType<typeof promptReadings>,
  lengths: number[],
  leading: boolean,
): void {
  for (const words of readings.plain) {
    for (const length of lengths) {
      for (let from = 0; from + length <= words.length; from++) {
        set.plain.add(words.slice(from, from + length).join(' '));
      }
    }
  }
  const slotted = readings.slotted ?? [];
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

/** Where in `run` the canary's place fell when `set` has it: -1 for nowhere, undefined when not a run. */
function matchRun(set: RunSet, run: readonly string[]): number | undefined {
  if (set.plain.has(run.join(' '))) return -1;
  for (const slot of set.slots) {
    if (slot < run.length && set.slotted.has(slotKey(run, slot))) return slot;
  }
  return undefined;
}

let gramsCache: { system: string; canary?: string; grams: RunSet } | undefined;

/** Every run of `PROMPT_ECHO_WORDS` words in the system prompt. */
function promptGrams(system: string, canary?: string): RunSet {
  if (gramsCache?.system === system && gramsCache.canary === canary) {
    return gramsCache.grams;
  }
  const grams: RunSet = { plain: new Set(), slotted: new Set(), slots: new Set() };
  addRuns(grams, promptReadings(system, canary), [PROMPT_ECHO_WORDS], true);
  gramsCache = { system, canary, grams };
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

let shapeCache: { system: string; canary?: string; shape: PromptShape } | undefined;

function promptShape(system: string, canary?: string): PromptShape {
  if (shapeCache?.system === system && shapeCache.canary === canary) {
    return shapeCache.shape;
  }
  const readings = promptReadings(system, canary);
  const shape: PromptShape = {
    runs: { plain: new Set(), slotted: new Set(), slots: new Set() },
    prefixes: new Set(),
    longest: 0,
  };
  for (const word of readings.plain[0] as string[]) {
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
  shapeCache = { system, canary, shape };
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
function promptEchoHoldFrom(text: string, system: string, canary?: string): number {
  const tail = promptEchoScanFrom(text, text.length);
  const words = echoWords(text.slice(tail));
  let writing = text.length;
  while (writing > 0 && WORD_CHAR.test(text.charAt(writing - 1))) writing--;
  const complete = words.filter(
    (entry) => tail + entry.to < text.length || writing === text.length,
  );
  const shape = promptShape(system, canary);
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

/** Offsets `[start, end)` of `text` that repeat the system prompt, ordered by start. */
function promptEchoRanges(text: string, system: string, canary?: string): Array<[number, number]> {
  const grams = promptGrams(system, canary);
  if (!text || grams.plain.size === 0) {
    return [];
  }
  const words = echoWords(text);
  const ranges: Array<[number, number]> = [];
  for (let from = 0; from + PROMPT_ECHO_WORDS <= words.length; from++) {
    const run = words.slice(from, from + PROMPT_ECHO_WORDS).map((entry) => entry.word);
    const slot = matchRun(grams, run);
    if (slot === undefined) continue;
    // A stand-in for the canary at either end is the model's, not the prompt's.
    const first = slot === 0 ? from + 1 : from;
    const last = slot === PROMPT_ECHO_WORDS - 1 ? from + slot - 1 : from + PROMPT_ECHO_WORDS - 1;
    ranges.push([words[first]?.at ?? 0, words[last]?.to ?? 0]);
  }
  return ranges;
}

/** Whether `text` repeats `PROMPT_ECHO_WORDS` consecutive words of the system prompt. */
function scanTextForPromptEcho(text: string, system: string, canary?: string): boolean {
  return promptEchoRanges(text, system, canary).length > 0;
}

/**
 * Where a scan of `text` must start when everything before `from` was
 * already scanned clean: at the word an echo run ending past `from` could
 * start in.
 */
function promptEchoScanFrom(text: string, from: number): number {
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
