import { blobAt, mergeSpans, type RedactSpan, spansFromPatterns } from '../observability/spans.ts';
import { REVERSED_INJECTION_PATTERNS } from './egress-automata.ts';
import {
  BASE64_BLOB,
  HEX_BLOB,
  INJECTION_PATTERNS,
  PIPE_SEPARATED,
  SPACED_LETTERS,
} from './injection-patterns.ts';
import { normalizeForDetection } from './normalize.ts';

const TYPO_TARGETS = [
  'ignore',
  'bypass',
  'override',
  'reveal',
  'delete',
  'system',
  'prompt',
  'instructions',
  'safety',
  'security',
  'filters',
  'rules',
  'previous',
  'guidelines',
  'restrictions',
  'disregard',
  'forget',
  'jailbreak',
  'developer',
  'disable',
  'measures',
  'output',
];

/** The shortest target a one-edit misspelling is read as: a shorter word has too many real neighbours. */
const EDIT_TARGET_MIN = 6;

/**
 * Real words one edit from a target (`forgot`, `safely`, `filter`): the dictionary's, and the
 * inflections it leaves out. They are words, not misspellings.
 */
const REAL_WORDS: ReadonlySet<string> = new Set([
  'instruction',
  'filter',
  'guideline',
  'restriction',
  'measure',
  'ignote',
  'bypast',
  'overrode',
  'overrife',
  'overripe',
  'overrise',
  'overrude',
  'overside',
  'overtide',
  'overwide',
  'redeal',
  'reheal',
  'repeal',
  'reseal',
  'reveil',
  'revel',
  'delate',
  'deplete',
  'safely',
  'fitters',
  'precious',
  'premious',
  'prepious',
  'forge',
  'forged',
  'forger',
  'forges',
  'forgot',
  'forlet',
  'forpet',
  'forset',
  'gorget',
  'developed',
  'measured',
  'measurer',
  'outcut',
  'outhut',
  'outjut',
]);

const TYPO_TARGET_SET: ReadonlySet<string> = new Set(TYPO_TARGETS);

/** Pipe evasion only when the first token is a known injection lead-in. */
const PIPE_HEAD_VERBS =
  /^(ignore|disregard|forget|bypass|reveal|show|repeat|output|disable|override|new|jailbreak|pretend|act|enter|activate|void|supersede|do)$/i;
const WORD = /\b[A-Za-z]{4,}\b/g;
const PRINTABLE_MIN = 0.85;
const CODE_TAB = 9;
const CODE_LF = 10;
const CODE_CR = 13;
const CODE_SPACE = 32;
const CODE_DEL = 127;
const HEX_RADIX = 16;
const HEX_STEP = 2;
const ROT13_OFFSET = 13;
const ALPHA_COUNT = 26;
const UPPER_A_CODE = 65;
const LOWER_A_CODE = 97;

function injectionSpansOn(text: string): RedactSpan[] {
  return spansFromPatterns(text, INJECTION_PATTERNS, 'injection');
}

function sortedLetters(value: string): string {
  return [...value].sort().join('');
}

function firstLast(word: string): { first: string | undefined; last: string | undefined } {
  return { first: word.at(0), last: word.at(-1) };
}

function isTypoglycemia(word: string, target: string): boolean {
  if (word.length !== target.length) {
    return false;
  }
  const lower = word.toLowerCase();
  if (lower === target) {
    return false;
  }
  const wordEnds = firstLast(lower);
  const targetEnds = firstLast(target);
  if (wordEnds.first !== targetEnds.first || wordEnds.last !== targetEnds.last) {
    return false;
  }
  return sortedLetters(lower.slice(1, -1)) === sortedLetters(target.slice(1, -1));
}

/** Whether one insertion, deletion, substitution or swap of two neighbours turns `word` into `target`. */
function isOneEdit(word: string, target: string): boolean {
  const wordEnd = word.length - 1;
  const targetEnd = target.length - 1;
  if (word[0] !== target[0] && word[wordEnd] !== target[targetEnd]) {
    return false;
  }
  const short = Math.min(word.length, target.length);
  let head = 0;
  while (head < short && word[head] === target[head]) {
    head += 1;
  }
  let tail = 0;
  while (tail < short - head && word[wordEnd - tail] === target[targetEnd - tail]) {
    tail += 1;
  }
  if (word.length !== target.length) {
    return head + tail === short;
  }
  const differing = short - head - tail;
  return (
    differing === 1 ||
    (differing === 2 && word[head] === target[head + 1] && word[head + 1] === target[head])
  );
}

/**
 * Whether `word` is `target` misspelt by one edit. A real word is not: one of
 * {@linkcode REAL_WORDS}, or the target with a letter added at its end
 * (`ignored`, `systems`).
 */
function isMisspelling(word: string, target: string): boolean {
  return isOneEdit(word, target) && !REAL_WORDS.has(word) && word.slice(0, -1) !== target;
}

/** For a word length, the targets a scramble of that length can be, and the targets a one-edit misspelling of it can be. */
const TARGETS_BY_LENGTH = new Map<number, { same: string[]; near: string[] }>();
for (
  let length = 4;
  length <= Math.max(...TYPO_TARGETS.map((target) => target.length)) + 1;
  length += 1
) {
  TARGETS_BY_LENGTH.set(length, {
    same: TYPO_TARGETS.filter((target) => target.length === length),
    near: TYPO_TARGETS.filter(
      (target) => target.length >= EDIT_TARGET_MIN && Math.abs(target.length - length) <= 1,
    ),
  });
}

/** The target `word` is read as, or `undefined`: a scramble of one first, then a one-edit misspelling. */
function targetOf(word: string): string | undefined {
  const targets = TARGETS_BY_LENGTH.get(word.length);
  if (targets === undefined) {
    return undefined;
  }
  const lower = word.toLowerCase();
  if (TYPO_TARGET_SET.has(lower)) {
    return undefined;
  }
  return (
    targets.same.find((target) => isTypoglycemia(lower, target)) ??
    targets.near.find((target) => isMisspelling(lower, target))
  );
}

/** A word `typoNormalize` rewrites: where it is in the text, and the target it becomes. */
interface Fold {
  start: number;
  end: number;
  to: string;
}

function typoFolds(text: string): Fold[] {
  const folds: Fold[] = [];
  for (const match of text.matchAll(WORD)) {
    const to = targetOf(match[0]);
    if (to !== undefined) {
      folds.push({ start: match.index, end: match.index + match[0].length, to });
    }
  }
  return folds;
}

function applyFolds(text: string, folds: readonly Fold[]): string {
  let out = '';
  let at = 0;
  for (const fold of folds) {
    out += text.slice(at, fold.start) + fold.to;
    at = fold.end;
  }
  return out + text.slice(at);
}

function typoNormalize(text: string): string {
  return applyFolds(text, typoFolds(text));
}

/**
 * `typoNormalize(text)`, and for an index in it the index of `text` it stands
 * for. A corrected word may be a letter longer or shorter than the word as
 * written, so an index past the written word stands for its last letter.
 */
function typoFolded(text: string): { text: string; at: (index: number) => number } {
  const folds = typoFolds(text);
  const at = (index: number): number => {
    let shift = 0;
    for (const fold of folds) {
      const start = fold.start + shift;
      if (index < start) {
        break;
      }
      if (index < start + fold.to.length) {
        return fold.start + Math.min(index - start, fold.end - fold.start - 1);
      }
      shift += fold.to.length - (fold.end - fold.start);
    }
    return index - shift;
  };
  return { text: applyFolds(text, folds), at };
}

function isMostlyPrintable(value: string): boolean {
  if (!value) {
    return false;
  }
  let ok = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const control = code === CODE_TAB || code === CODE_LF || code === CODE_CR;
    const visible = code >= CODE_SPACE && code < CODE_DEL;
    if (control || visible) {
      ok += 1;
    }
  }
  return ok / value.length >= PRINTABLE_MIN;
}

function tryBase64(blob: string): string | undefined {
  try {
    return atob(blob);
  } catch {
    return undefined;
  }
}

function decodedHits(decoded: string): boolean {
  if (!isMostlyPrintable(decoded)) {
    return false;
  }
  if (injectionSpansOn(decoded).length > 0) return true;
  const doubleDecoded = tryBase64(decoded);
  if (
    doubleDecoded &&
    isMostlyPrintable(doubleDecoded) &&
    injectionSpansOn(doubleDecoded).length > 0
  ) {
    return true;
  }
  return false;
}

function tryHex(blob: string): string | undefined {
  const hex = blob.replaceAll(/\s/g, '');
  if (hex.length % HEX_STEP !== 0) {
    return undefined;
  }
  let out = '';
  for (let i = 0; i < hex.length; i += HEX_STEP) {
    out += String.fromCodePoint(Number.parseInt(hex.slice(i, i + HEX_STEP), HEX_RADIX));
  }
  return out;
}

function base64Hit(blob: string): boolean {
  const decoded = tryBase64(blob);
  return decoded !== undefined && decodedHits(decoded);
}

function hexHit(blob: string): boolean {
  const decoded = tryHex(blob);
  return decoded !== undefined && decodedHits(decoded);
}

function spacedHit(blob: string): boolean {
  const collapsed = blob.replaceAll(' ', '');
  return injectionSpansOn(`${collapsed} previous instructions`).length > 0;
}

function pipeHit(blob: string): boolean {
  const head = blob.split('|')[0]?.toLowerCase();
  if (!head || !PIPE_HEAD_VERBS.test(head)) return false;
  return injectionSpansOn(blob.replaceAll('|', ' ')).length > 0;
}

/** Blob patterns whose match is a hit only when the blob decodes to an injection. */
const INJECTION_BLOBS: readonly { pattern: RegExp; hit: (blob: string) => boolean }[] = [
  { pattern: BASE64_BLOB, hit: base64Hit },
  { pattern: HEX_BLOB, hit: hexHit },
  { pattern: SPACED_LETTERS, hit: spacedHit },
  { pattern: PIPE_SEPARATED, hit: pipeHit },
];

function blobSpans(text: string): RedactSpan[] {
  const spans: RedactSpan[] = [];
  for (const { pattern, hit } of INJECTION_BLOBS) {
    for (const match of text.matchAll(pattern)) {
      const found = blobAt(match);
      if (found && hit(found.blob)) {
        spans.push({ start: found.index, end: found.index + found.blob.length, kind: 'injection' });
      }
    }
  }
  return spans;
}

function tryRot13(text: string): string {
  return text.replace(/[a-zA-Z]/g, (c) => {
    const base = c.charCodeAt(0) < LOWER_A_CODE ? UPPER_A_CODE : LOWER_A_CODE;
    return String.fromCharCode(((c.charCodeAt(0) - base + ROT13_OFFSET) % ALPHA_COUNT) + base);
  });
}

const URL_ESCAPES = /(?:%[0-9A-Fa-f]{2})+/g;
const UTF8 = new TextDecoder();

/** Each run of `%XX` escapes decoded on its own, so one stray `%` cannot switch decoding off. */
function decodeUrlRuns(text: string): string {
  return text.replace(URL_ESCAPES, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), HEX_RADIX);
    }
    return UTF8.decode(bytes);
  });
}

function tryUrlDecode(text: string): string | undefined {
  if (!text.includes('%')) return undefined;
  const decoded = decodeUrlRuns(text);
  return decoded !== text ? decoded : undefined;
}

const LEET_MAP: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '@': 'a',
  '!': 'i',
};

const LEET_CHARS = /[013457@!]/g;

function tryLeet(text: string): string | undefined {
  if (!LEET_CHARS.test(text)) return undefined;
  LEET_CHARS.lastIndex = 0;
  const decoded = text.replace(LEET_CHARS, (c) => LEET_MAP[c] ?? c);
  return decoded !== text ? decoded : undefined;
}

/**
 * Text written backwards reads as an injection: each pattern reversed
 * (`REVERSED_INJECTION_PATTERNS`), matched on the text as written.
 */
function reversedHits(text: string): boolean {
  return spansFromPatterns(text, REVERSED_INJECTION_PATTERNS, 'injection').length > 0;
}

function decodedTextSpans(text: string): RedactSpan[] {
  const attempts: (string | undefined)[] = [tryRot13(text), tryUrlDecode(text), tryLeet(text)];
  const decodedHit = attempts.some(
    (decoded) => decoded && decoded !== text && injectionSpansOn(decoded).length > 0,
  );
  return decodedHit || reversedHits(text)
    ? [{ start: 0, end: text.length, kind: 'injection' }]
    : [];
}

/** The spans of injection in the text, each stretch once: direct matches, matches after typo normalization, the whole text when only a Unicode-normalized form matches, and encoded blobs and decoded text. */
function injectionSpans(text: string): RedactSpan[] {
  const direct = injectionSpansOn(text);

  const folded = typoFolded(text);
  let typo: RedactSpan[] = [];
  if (folded.text !== text) {
    typo = injectionSpansOn(folded.text).map((span) => ({
      ...span,
      start: folded.at(span.start),
      end: folded.at(span.end - 1) + 1,
    }));
  }

  const normalized = normalizeForDetection(text);
  let unicodeHits: RedactSpan[] = [];
  if (normalized !== text) {
    const normalizedTypo = typoNormalize(normalized);
    if (
      injectionSpansOn(normalized).length > 0 ||
      (normalizedTypo !== normalized && injectionSpansOn(normalizedTypo).length > 0)
    ) {
      unicodeHits = [{ start: 0, end: text.length, kind: 'injection' }];
    }
  }

  return mergeSpans([
    ...direct,
    ...typo,
    ...unicodeHits,
    ...blobSpans(text),
    ...decodedTextSpans(text),
  ]);
}

export {
  decodeUrlRuns,
  INJECTION_BLOBS,
  injectionSpans,
  LEET_MAP,
  TYPO_TARGETS,
  tryLeet,
  tryRot13,
  typoFolded,
  typoNormalize,
};
