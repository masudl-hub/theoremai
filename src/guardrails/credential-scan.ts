/**
 * Credentials found the way gitleaks finds them: a rule's regex, then the
 * secret in it (its `secretGroup`, else its first non-empty group), dropped
 * when the rule's keywords are not in the text, when the secret's Shannon
 * entropy is at or under the rule's floor, or when an allowlist lets it through.
 *
 * gitleaks reads a rule's keywords anywhere in a file. Here one must be in the
 * text by the end of the match, so a reply read as it streams and the reply
 * read whole find the same secrets.
 *
 * gitleaks' `gitleaks:allow` comment is not honoured: in a chat the model or
 * a page writes it, not the owner of the secret.
 *
 * @module
 */

import type { RedactSpan } from '../observability/spans.ts';

/** Matches a credential rule lets through. */
interface CredentialAllowlist {
  /** What the regexes read: the secret, the whole match, or the lines the match is on. */
  target: 'secret' | 'match' | 'line';
  regexes: readonly RegExp[];
  /** SHA-256 hex digests of values that let through, so a literal is not kept in source. */
  hashes: readonly string[];
  /** Words that, anywhere in the secret, case aside, let it through. */
  stopwords: readonly string[];
}

interface CredentialRule {
  id: string;
  pattern: RegExp;
  /** The group holding the secret; else the first non-empty group, else the match. */
  secretGroup?: number;
  /** The Shannon entropy, in bits per character, a secret must be over. */
  entropy?: number;
  /** Words, lower case, one of which the text must hold by the end of a match. */
  keywords: readonly string[];
  allowlists: readonly CredentialAllowlist[];
}

/** Shannon entropy over the characters of `data`, per UTF-8 byte as gitleaks counts it. */
function shannonEntropy(data: string): number {
  if (data === '') return 0;
  const counts = new Map<string, number>();
  for (const char of data) counts.set(char, (counts.get(char) ?? 0) + 1);
  const bytes = new TextEncoder().encode(data).length;
  let entropy = 0;
  for (const count of counts.values()) {
    const freq = count / bytes;
    entropy -= freq * Math.log2(freq);
  }
  return entropy;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of `text` as lower-case hex, synchronously: the scan is synchronous and runs in the browser too. */
function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bits = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bits >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (k + S1 + ch + SHA256_K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      [k, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + t2) | 0];
    }
    const next = [a, b, c, d, e, f, g, k];
    for (let i = 0; i < 8; i++) h[i] = (h[i] + next[i]) | 0;
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}

function allowed(
  list: CredentialAllowlist,
  read: { secret: string; match: string; line: string },
): boolean {
  const target = read[list.target];
  const lower = read.secret.toLowerCase();
  return (
    (target !== '' && list.regexes.some((regex) => regex.test(target))) ||
    (target !== '' && list.hashes.length > 0 && list.hashes.includes(sha256Hex(target))) ||
    (lower !== '' && list.stopwords.some((word) => lower.includes(word)))
  );
}

/** The lines of `text` the stretch [start, end) is on. */
function linesOf(text: string, start: number, end: number): string {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const to = text.indexOf('\n', end);
  return text.slice(from, to < 0 ? text.length : to);
}

/** Whether one of `rule`'s keywords is in `lower`, the text in lower case, by `end`. */
function keywordsIn(rule: CredentialRule, lower: string, end = lower.length): boolean {
  return (
    rule.keywords.length === 0 ||
    rule.keywords.some((word) => {
      const at = lower.indexOf(word);
      return at >= 0 && at + word.length <= end;
    })
  );
}

const FINDERS = new WeakMap<RegExp, RegExp>();

/** `pattern` with its indices, read from the start of a string. */
function finder(pattern: RegExp): RegExp {
  let found = FINDERS.get(pattern);
  if (!found) {
    found = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}d`);
    FINDERS.set(pattern, found);
  }
  return found;
}

/**
 * Where the secret in `rule`'s match at `at` of `text` is, or undefined when
 * gitleaks would let the match through. Keywords are not read here.
 */
function credentialSecret(
  rule: CredentialRule,
  global: CredentialAllowlist,
  text: string,
  match: string,
  at: number,
): { start: number; end: number } | undefined {
  let lead = 0;
  while (match[lead] === '\n') lead++;
  let tail = match.length;
  while (tail > lead && match[tail - 1] === '\n') tail--;
  const trimmed = match.slice(lead, tail);
  const start = at + lead;
  let secret = { start, end: start + trimmed.length };
  const groups = finder(rule.pattern).exec(trimmed);
  const indices = groups?.indices;
  if (groups && indices && groups.length >= 2) {
    const group =
      rule.secretGroup ??
      groups.findIndex((value, index) => index > 0 && value !== undefined && value !== '');
    const span = indices[group];
    if (span) secret = { start: start + span[0], end: start + span[1] };
    else if (rule.secretGroup) secret = { start, end: start };
  }
  const read = {
    secret: text.slice(secret.start, secret.end),
    match: trimmed,
    line: linesOf(text, start, start + trimmed.length),
  };
  if (rule.entropy !== undefined && shannonEntropy(read.secret) <= rule.entropy) return undefined;
  if (allowed(global, read) || rule.allowlists.some((list) => allowed(list, read))) {
    return undefined;
  }
  return secret.end > secret.start ? secret : { start, end: start + trimmed.length };
}

/** The secrets `rules` find in `text`, each one's span. */
function credentialSpans(
  text: string,
  rules: readonly CredentialRule[],
  global: CredentialAllowlist,
): RedactSpan[] {
  const lower = text.toLowerCase();
  const spans: RedactSpan[] = [];
  for (const rule of rules) {
    if (!keywordsIn(rule, lower)) continue;
    const pattern = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
    for (const match of text.matchAll(pattern)) {
      if (match[0] === '' || !keywordsIn(rule, lower, match.index + match[0].length)) continue;
      const secret = credentialSecret(rule, global, text, match[0], match.index);
      if (secret) spans.push({ ...secret, kind: 'sensitive' });
    }
  }
  return spans;
}

/** Whether a match of `rule` at `at` of `text` is a credential gitleaks reports. */
function credentialHit(
  rule: CredentialRule,
  global: CredentialAllowlist,
  match: string,
  text: string,
  at: number,
): boolean {
  return (
    keywordsIn(rule, text.slice(0, at + match.length).toLowerCase()) &&
    credentialSecret(rule, global, text, match, at) !== undefined
  );
}

export type { CredentialAllowlist, CredentialRule };
export { credentialHit, credentialSpans, shannonEntropy };
