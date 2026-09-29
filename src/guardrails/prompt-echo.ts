/**
 * System-prompt echo — the leak the canary cannot see.
 *
 * The canary proves the token leaked; a reply that restates the system prompt
 * while leaving the token out trips nothing. This check reads the reply for a
 * run of `PROMPT_ECHO_WORDS` consecutive words of the system prompt. Words are
 * compared case-folded after Unicode compatibility folding, punctuation and
 * markup between them ignored, and bare numbers skipped, so reformatting a
 * dump as a numbered or bulleted list does not hide it. A streamed reply holds
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

function gram(words: EchoWord[], from: number): string {
  return words
    .slice(from, from + PROMPT_ECHO_WORDS)
    .map((entry) => entry.word)
    .join(' ');
}

let gramsCache: { system: string; grams: Set<string> } | undefined;

/** Every run of `PROMPT_ECHO_WORDS` words in the system prompt. */
function promptGrams(system: string): Set<string> {
  if (gramsCache?.system === system) {
    return gramsCache.grams;
  }
  const words = echoWords(system);
  const grams = new Set<string>();
  for (let from = 0; from + PROMPT_ECHO_WORDS <= words.length; from++) {
    grams.add(gram(words, from));
  }
  gramsCache = { system, grams };
  return grams;
}

interface PromptShape {
  /** Every run of fewer than `PROMPT_ECHO_WORDS` words. */
  runs: Set<string>;
  /** Every all-ASCII prefix of a word. */
  prefixes: Set<string>;
  /** The longest word, in code units. */
  longest: number;
}

let shapeCache: { system: string; shape: PromptShape } | undefined;

function promptShape(system: string): PromptShape {
  if (shapeCache?.system === system) {
    return shapeCache.shape;
  }
  const words = echoWords(system).map((entry) => entry.word);
  const shape: PromptShape = { runs: new Set(), prefixes: new Set(), longest: 0 };
  for (let from = 0; from < words.length; from++) {
    const word = words[from] as string;
    shape.longest = Math.max(shape.longest, word.length);
    for (let end = 1; end <= word.length && ASCII.test(word.charAt(end - 1)); end++) {
      shape.prefixes.add(word.slice(0, end));
    }
    let run = '';
    for (let length = 1; length < PROMPT_ECHO_WORDS && from + length <= words.length; length++) {
      run = length === 1 ? word : `${run} ${words[from + length - 1]}`;
      shape.runs.add(run);
    }
  }
  shapeCache = { system, shape };
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
function promptEchoHoldFrom(text: string, system: string): number {
  const tail = promptEchoScanFrom(text, text.length);
  const words = echoWords(text.slice(tail));
  let writing = text.length;
  while (writing > 0 && WORD_CHAR.test(text.charAt(writing - 1))) writing--;
  const complete = words.filter(
    (entry) => tail + entry.to < text.length || writing === text.length,
  );
  const shape = promptShape(system);
  const hold = mayBecomePromptWord(text.slice(writing), shape) ? writing : text.length;
  for (
    let from = Math.max(0, complete.length - (PROMPT_ECHO_WORDS - 1));
    from < complete.length;
    from++
  ) {
    const run = complete
      .slice(from)
      .map((entry) => entry.word)
      .join(' ');
    if (shape.runs.has(run)) {
      return Math.min(hold, tail + (complete[from] as EchoWord).at);
    }
  }
  return hold;
}

/** Offsets `[start, end)` of `text` that repeat the system prompt, ordered by start. */
function promptEchoRanges(text: string, system: string): Array<[number, number]> {
  const grams = promptGrams(system);
  if (!text || grams.size === 0) {
    return [];
  }
  const words = echoWords(text);
  const ranges: Array<[number, number]> = [];
  for (let from = 0; from + PROMPT_ECHO_WORDS <= words.length; from++) {
    if (grams.has(gram(words, from))) {
      ranges.push([words[from]?.at ?? 0, words[from + PROMPT_ECHO_WORDS - 1]?.to ?? 0]);
    }
  }
  return ranges;
}

/** Whether `text` repeats `PROMPT_ECHO_WORDS` consecutive words of the system prompt. */
function scanTextForPromptEcho(text: string, system: string): boolean {
  return promptEchoRanges(text, system).length > 0;
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
