/**
 * Prompt-injection span detection.
 *
 * These utilities return spans that can be redacted from untrusted user text
 * before provider submission.
 *
 * @module
 */

import { blobAt, type RedactSpan, spansFromPatterns } from '../observability/spans.ts';
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
];

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

function typoNormalize(text: string): string {
  return text.replace(WORD, (word) => {
    for (const target of TYPO_TARGETS) {
      if (isTypoglycemia(word, target)) {
        return target;
      }
    }
    return word;
  });
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

// ── Encoding evasion decoders ────────────────────────────────────────

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

// ── Main entry point ─────────────────────────────────────────────────

function injectionSpans(text: string): RedactSpan[] {
  const direct = injectionSpansOn(text);

  const shadow = typoNormalize(text);
  let typo: RedactSpan[] = [];
  if (shadow !== text) {
    typo = injectionSpansOn(shadow);
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

  return [...direct, ...typo, ...unicodeHits, ...blobSpans(text), ...decodedTextSpans(text)];
}

export {
  decodeUrlRuns,
  INJECTION_BLOBS,
  injectionSpans,
  TYPO_TARGETS,
  tryLeet,
  tryRot13,
  typoNormalize,
};
