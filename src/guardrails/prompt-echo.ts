/**
 * System-prompt echo — the leak the canary cannot see.
 *
 * The canary proves the token leaked; a reply that restates the system prompt
 * while leaving the token out trips nothing. This check reads the reply for a
 * run of `PROMPT_ECHO_WORDS` consecutive words of the system prompt. Words are
 * compared case-folded after Unicode compatibility folding, punctuation and
 * markup between them ignored, and bare numbers skipped, so reformatting a
 * dump as a numbered or bulleted list does not hide it. There is no hold: a
 * dump is stopped at its `PROMPT_ECHO_WORDS`th word, so at most one word
 * fewer ever reaches the host.
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

export { PROMPT_ECHO_WORDS, promptEchoRanges, promptEchoScanFrom, scanTextForPromptEcho };
