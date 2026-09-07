/**
 * Sensitive-data span detection.
 *
 * Detects common credentials, tokens, card numbers, SSNs, and network secrets
 * so host profiles can redact them before provider submission.
 *
 * @module
 */

import { blobAt, type RedactSpan, spansFromPatterns } from '../observability/spans.ts';

const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const SSN_CONTEXTUAL = /(?:SSN|social\s*security(?:\s*number)?)[:\s]+(?:\d[-\s]*){9}/gi;
const ITIN = /\b9\d{2}-\d{2}-\d{4}\b/g;
const EIN = /\b\d{2}-\d{7}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{13,30}\b/g;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi;
const AWS_ACCESS = /\bAKIA[0-9A-Z]{16,20}\b/g;
const GOOGLE_API = /\bAIza[0-9A-Za-z_-]{35}\b/g;
const OPENAI_KEY = /\bsk-\s*[A-Za-z0-9]{20,}\b/g;
const ANTHROPIC_KEY = /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g;
const OPENROUTER_KEY = /\bsk-or-[A-Za-z0-9_-]{20,}\b/g;
const GITHUB_PAT = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g;
const GITHUB_TOKEN = /\bghp_[A-Za-z0-9]{36}\b/g;
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
/** Bounded payload so PEM redaction cannot ReDoS on repeated BEGIN markers. */
const PEM_KEY =
  /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]{0,16384}?-----END (?:RSA )?PRIVATE KEY-----/g;
const CARD_CANDIDATE = /\b(?:\d[\s.-]*?){13,19}\b/g;

const KEY_PATTERNS = [
  SSN,
  SSN_CONTEXTUAL,
  ITIN,
  EIN,
  IBAN,
  IPV4,
  IPV6,
  AWS_ACCESS,
  GOOGLE_API,
  OPENAI_KEY,
  ANTHROPIC_KEY,
  OPENROUTER_KEY,
  GITHUB_PAT,
  GITHUB_TOKEN,
  SLACK_TOKEN,
  BEARER,
  PEM_KEY,
];

const LUHN_DOUBLE = 2;
const LUHN_NINE = 9;
const LUHN_TEN = 10;
const CARD_MIN_DIGITS = 13;
const CARD_MAX_DIGITS = 19;

function luhnOk(digits: string): boolean {
  let sum = 0;
  let doubleIt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const ch = digits[i];
    if (ch === undefined) {
      return false;
    }
    let n = Number(ch);
    if (doubleIt) {
      n *= LUHN_DOUBLE;
      if (n > LUHN_NINE) {
        n -= LUHN_NINE;
      }
    }
    sum += n;
    doubleIt = !doubleIt;
  }
  return sum % LUHN_TEN === 0;
}

function cardSpans(text: string): RedactSpan[] {
  const spans: RedactSpan[] = [];
  for (const match of text.matchAll(CARD_CANDIDATE)) {
    const found = blobAt(match);
    if (found) {
      const digits = found.blob.replaceAll(/[^\d]/g, '');
      const inRange = digits.length >= CARD_MIN_DIGITS && digits.length <= CARD_MAX_DIGITS;
      if (inRange && luhnOk(digits)) {
        spans.push({ start: found.index, end: found.index + found.blob.length, kind: 'sensitive' });
      }
    }
  }
  return spans;
}

/** Detect sensitive-data spans in a string. */
function sensitiveSpans(text: string): RedactSpan[] {
  return [...spansFromPatterns(text, KEY_PATTERNS, 'sensitive'), ...cardSpans(text)];
}

export { sensitiveSpans };
