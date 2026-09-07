/**
 * Prompt-injection span detection.
 *
 * These utilities return spans that can be redacted from untrusted user text
 * before provider submission.
 *
 * @module
 */

import { blobAt, type RedactSpan, spansFromPatterns } from '../observability/spans.ts';
import { normalizeForDetection } from './normalize.ts';

const IGNORE_PREVIOUS =
  /ignore\s+(all\s+)?(previous|prior)\s+((?:safety|security|system|operational|internal|core|original|initial|existing|given|stated|provided|defined|specified|established)\s+)?(instructions?|rules?|guidelines?|constraints?|directives?)/gi;
const DISREGARD_INSTRUCTIONS =
  /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?|guidelines?|constraints?|directives?)/gi;
const FORGET_INSTRUCTIONS =
  /forget\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?|guidelines?|constraints?|directives?)/gi;
const NEW_INSTRUCTIONS = /new\s+instructions?:/gi;
const DO_NOT_FOLLOW = /do\s+not\s+follow\s+(the\s+)?(system|developer|previous|original)/gi;
const SUPERSEDE_INSTRUCTIONS =
  /supersedes?\s+(all\s+)?(prior|previous)\s+(instructions?|rules?|guidelines?|constraints?|directives?)/gi;
const VOID_INSTRUCTIONS =
  /(all\s+)?(previous|prior)\s+instructions?\s+(are|is)\s+(void|invalid|null|obsolete|cancelled|revoked)/gi;
const DEVELOPER_MODE = /you\s+are\s+now\s+(in\s+)?developer\s+mode/gi;
const ENTER_SPECIAL_MODE =
  /enter\s+(developer|admin|debug|maintenance)\s+mode(?!\s+(?:in|on|via|through|from|using|for)\b)/gi;
const ACTIVATE_SPECIAL_MODE =
  /activate\s+(developer|admin|debug|jailbreak)\s+mode(?!\s+(?:in|on|via|through|from|using|for)\b)/gi;
const SYSTEM_OVERRIDE = /\bsystem\s+override\b/gi;
const OVERRIDE_INSTRUCTIONS =
  /override\s+(your\s+)?(instructions?|rules?|guidelines?|constraints?|directives?)/gi;
const REVEAL_PROMPT =
  /reveal\s+((?:your?|yoru|yuor|the|my|its|his|her|our|their)\s+)?((?:(?:full|hidden|complete|internal|secret|original|entire|exact|actual|real)\s+){0,2})((?:system|systme|sysetm|systemp?)\s+)?prompt\b/gi;
const SHOW_PROMPT =
  /show\s+(me\s+)?((?:your?|yoru|yuor|the|my|its|his|her|our|their)\s+)((?:system|systme|sysetm|systemp?)\s+)?prompt\b/gi;
const WHAT_INSTRUCTIONS = /what\s+(are|were)\s+(your\s+)?(exact\s+)?instructions/gi;
const REPEAT_INSTRUCTIONS = /repeat\s+(the\s+)?(text|instructions?)\s+(above|before)/gi;
const OUTPUT_PROMPT = /output\s+(your\s+)?(initial|original|system)\s+(prompt|instructions?)/gi;
const REMOVE_RESTRICTIONS = /you\s+are\s+no\s+longer\s+(bound|restricted|limited)/gi;
const ACT_UNBOUND = /act\s+as\s+if\s+(you('re|\s+are)\s+)?not\s+bound/gi;
const PRETEND_DIFFERENT =
  /pretend\s+(you('re|\s+are)\s+)?(a\s+)?different\s+(ai|assistant|model)/gi;
const IDENTITY_HIJACK =
  /you\s+are\s+now\s+(?:(?:a|an)\s+)?\w+.{0,40}(without\s+(any\s+)?restrict|ignor\w*\s+(all|any|every|prev)|bypass|unrestrict|unlimit|obey\s+only|no\s+(rules|limits|restrict|boundari))/gi;
const DAN_JAILBREAK = /\bDAN\b[\s\S]{0,120}\bdo\s+anything\s+now\b/g;
const JAILBREAK_MODE = /jailbreak(ed)?\s+(mode|prompt)/gi;
const DO_ANYTHING_NOW = /\bdo\s+anything\s+now\b/gi;
const BYPASS_SAFETY =
  /bypass\s+(your\s+)?(safety|security|content|ethical)\s+(filters?|measures?|guidelines?|restrictions?)/gi;
const DISABLE_SAFETY =
  /(disable|delete|remove|turn\s+off|eliminate)\s+(all\s+)?(your\s+)?(safety|security|content)\s+(filters?|measures?|rules?|guidelines?|restrictions?)/gi;
const IGNORE_SAFETY =
  /(ignore|disregard)\s+(all\s+)?(your\s+)?(safety|security|ethical|content)\s+(guidelines?|rules?|restrictions?|measures?|filters?|polic(?:y|ies)|protocols?)/gi;
/** Bound whitespace so tag scanners cannot polynomial-backtrack on long runs. */
const TAG_WS = String.raw`[^\S\r\n]{0,32}`;
const SYSTEM_TAG = new RegExp(`<${TAG_WS}\\/?${TAG_WS}system${TAG_WS}\\/?>`, 'gi');
const ROLE_TAG = new RegExp(
  `<${TAG_WS}\\/?${TAG_WS}(assistant|developer|tool|function)${TAG_WS}\\/?>`,
  'gi',
);
const ROLE_DELIMITER = /\][^\S\r\n]{0,32}\n[^\S\r\n]{0,32}\[?(system|assistant|user)\]?:/gi;
const BRACKETED_ROLE =
  /\[[^\S\r\n]{0,32}(System[^\S\r\n]{0,8}Message|System|Assistant|Internal)[^\S\r\n]{0,32}\]/gi;
const SYSTEM_YOU_ARE = /^[^\S\r\n]{0,32}System:[^\S\r\n]{1,32}(you\s+are|ignore|override)/gim;
const CONTROL_TOKEN = /<\|(?:im_start|im_end|eot_id|start_header_id|end_header_id|endoftext)\|>/g;
const DEEPSEEK_CONTROL = /<｜(?:end▁of▁sentence|begin▁of▁sentence)｜>/g;
const LLAMA_INST = /\[\/?INST\]/gi;
const IGNORE_YOUR_INSTRUCTIONS = /ignore\s+(all\s+)?(your\s+)?(instructions?|rules?)\b/gi;
const UNRESTRICTED_MODE = /\bunrestricted\s+(ai|mode|model)\b/gi;
const IGNORE_MULTILANG =
  /\b(?:ignorieren|ignorez|ignora|ignorer|oubliez|vergessen|olvida|desestima|missachten)\b[\s\S]{0,50}\b(?:anweisungen|instructions?|instrucciones|directives?|r[eè]gles|reglas)\b/gi;

const INJECTION_PATTERNS = [
  IGNORE_PREVIOUS,
  DISREGARD_INSTRUCTIONS,
  FORGET_INSTRUCTIONS,
  NEW_INSTRUCTIONS,
  DO_NOT_FOLLOW,
  SUPERSEDE_INSTRUCTIONS,
  VOID_INSTRUCTIONS,
  DEVELOPER_MODE,
  ENTER_SPECIAL_MODE,
  ACTIVATE_SPECIAL_MODE,
  SYSTEM_OVERRIDE,
  OVERRIDE_INSTRUCTIONS,
  REVEAL_PROMPT,
  SHOW_PROMPT,
  WHAT_INSTRUCTIONS,
  REPEAT_INSTRUCTIONS,
  OUTPUT_PROMPT,
  REMOVE_RESTRICTIONS,
  ACT_UNBOUND,
  PRETEND_DIFFERENT,
  IDENTITY_HIJACK,
  DAN_JAILBREAK,
  JAILBREAK_MODE,
  DO_ANYTHING_NOW,
  BYPASS_SAFETY,
  DISABLE_SAFETY,
  IGNORE_SAFETY,
  SYSTEM_TAG,
  ROLE_TAG,
  ROLE_DELIMITER,
  BRACKETED_ROLE,
  SYSTEM_YOU_ARE,
  CONTROL_TOKEN,
  DEEPSEEK_CONTROL,
  LLAMA_INST,
  IGNORE_YOUR_INSTRUCTIONS,
  UNRESTRICTED_MODE,
  IGNORE_MULTILANG,
];

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

const BASE64_BLOB = /[A-Za-z0-9+/]{16,}={0,2}/g;
const HEX_BLOB = /(?:[0-9a-f]{2}[\s]?){8,}/gi;
const SPACED_LETTERS = /\b(?:[A-Za-z] ){3,}[A-Za-z]\b/g;
/** Three+ alphabetic tokens joined by `|` (no shell spaces around pipes). */
const PIPE_SEPARATED = /\b(?:[A-Za-z]+\|){2,}[A-Za-z]+\b/g;
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

function encodedFrom(
  text: string,
  pattern: RegExp,
  decode: (blob: string) => string | undefined,
): RedactSpan[] {
  const spans: RedactSpan[] = [];
  for (const match of text.matchAll(pattern)) {
    const found = blobAt(match);
    if (found) {
      const decoded = decode(found.blob);
      if (decoded && decodedHits(decoded)) {
        spans.push({ start: found.index, end: found.index + found.blob.length, kind: 'injection' });
      }
    }
  }
  return spans;
}

function encodedSpans(text: string): RedactSpan[] {
  return [...encodedFrom(text, BASE64_BLOB, tryBase64), ...encodedFrom(text, HEX_BLOB, tryHex)];
}

function spacedSpans(text: string): RedactSpan[] {
  const spans: RedactSpan[] = [];
  for (const match of text.matchAll(SPACED_LETTERS)) {
    const found = blobAt(match);
    if (found) {
      const collapsed = found.blob.replaceAll(' ', '');
      if (injectionSpansOn(`${collapsed} previous instructions`).length > 0) {
        spans.push({ start: found.index, end: found.index + found.blob.length, kind: 'injection' });
      }
    }
  }
  return spans;
}

function pipeSeparatedSpans(text: string): RedactSpan[] {
  const spans: RedactSpan[] = [];
  for (const match of text.matchAll(PIPE_SEPARATED)) {
    const found = blobAt(match);
    if (!found) continue;
    const head = found.blob.split('|')[0]?.toLowerCase();
    if (!head || !PIPE_HEAD_VERBS.test(head)) continue;
    const collapsed = found.blob.replaceAll('|', ' ');
    if (injectionSpansOn(collapsed).length > 0) {
      spans.push({ start: found.index, end: found.index + found.blob.length, kind: 'injection' });
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

function tryUrlDecode(text: string): string | undefined {
  if (!text.includes('%')) return undefined;
  try {
    const decoded = decodeURIComponent(text);
    return decoded !== text ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function tryReverse(text: string): string {
  return [...text].reverse().join('');
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

function decodedTextSpans(text: string): RedactSpan[] {
  const attempts: (string | undefined)[] = [tryRot13(text), tryUrlDecode(text), tryLeet(text)];
  const reversed = tryReverse(text);
  if (reversed !== text) {
    attempts.push(reversed);
  }
  for (const decoded of attempts) {
    if (decoded && decoded !== text && injectionSpansOn(decoded).length > 0) {
      return [{ start: 0, end: text.length, kind: 'injection' }];
    }
  }
  return [];
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

  return [
    ...direct,
    ...typo,
    ...unicodeHits,
    ...encodedSpans(text),
    ...spacedSpans(text),
    ...pipeSeparatedSpans(text),
    ...decodedTextSpans(text),
  ];
}

export { injectionSpans };
