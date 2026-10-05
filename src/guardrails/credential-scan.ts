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

function allowed(
  list: CredentialAllowlist,
  read: { secret: string; match: string; line: string },
): boolean {
  const target = read[list.target];
  const lower = read.secret.toLowerCase();
  return (
    (target !== '' && list.regexes.some((regex) => regex.test(target))) ||
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
  const lead = match.length - match.replace(/^\n+/, '').length;
  const trimmed = match.slice(lead).replace(/\n+$/, '');
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
