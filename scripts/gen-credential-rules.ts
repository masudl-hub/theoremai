/**
 * Writes `src/guardrails/credential-rules.ts` from gitleaks' default rules
 * (`scripts/gitleaks/gitleaks.toml`, gitleaks v8.30.1, MIT, `scripts/gitleaks/LICENSE`).
 *
 * Each Go regex is rewritten to a JavaScript one that matches the same text:
 *
 * - An inline `(?i)` or `(?s)` holds to the end of its group, across `|`.
 *   JavaScript's `(?i:…)` modifier is not in Node 20, so case is spelled out
 *   (`[aA]`) wherever a modifier sets or clears it; a pattern ignoring case
 *   throughout takes the `i` flag.
 * - Go's `.` is any character but `\n`, and `\s` is `[\t\n\f\r ]`.
 * - `\z` is the end of the text, `(?P<name>` a named group, `[:alnum:]` letters and digits.
 * - A range a class already holds is written once.
 *
 * A rule or allowlist that only applies to a file path cannot apply to a chat
 * and is left out.
 *
 *   deno run --allow-read --allow-write --allow-run scripts/gen-credential-rules.ts
 *
 * @module
 */

import { type AST, RegExpParser } from '@eslint-community/regexpp';
import { parse } from '@std/toml';
import type { CredentialAllowlist, CredentialRule } from '../src/guardrails/credential-scan.ts';

const SOURCE = new URL('./gitleaks/gitleaks.toml', import.meta.url);
const OUT = new URL('../src/guardrails/credential-rules.ts', import.meta.url);

interface GitleaksAllowlist {
  condition?: 'OR' | 'AND';
  regexTarget?: 'secret' | 'match' | 'line';
  regexes?: string[];
  stopwords?: string[];
  paths?: string[];
  commits?: string[];
}

interface GitleaksRule {
  id: string;
  regex?: string;
  path?: string;
  secretGroup?: number;
  entropy?: number;
  keywords?: string[];
  allowlists?: GitleaksAllowlist[];
}

interface GitleaksConfig {
  allowlist: GitleaksAllowlist;
  rules: GitleaksRule[];
}

// ── Go regex to JavaScript ───────────────────────────────────────────

const GO_SPACE = '\\t\\n\\f\\r ';

/** The index just past the group or class opening at `at`, or of the escape there. */
function skipAtom(source: string, at: number): number {
  if (source[at] === '\\') return at + 2;
  if (source[at] !== '[') return at + 1;
  let i = at + 1;
  if (source[i] === '^') i++;
  if (source[i] === ']') i++;
  while (i < source.length && source[i] !== ']') {
    if (source[i] === '\\') i++;
    else if (source.startsWith('[:', i)) i = source.indexOf(':]', i) + 1;
    i++;
  }
  return i + 1;
}

/** Where the group holding `at` closes, and where each `|` at its depth after `at` is. */
function groupRest(source: string, at: number): { end: number; bars: number[] } {
  const bars: number[] = [];
  let depth = 0;
  let i = at;
  while (i < source.length) {
    const char = source[i];
    if (char === '(') depth++;
    else if (char === ')') {
      if (depth === 0) return { end: i, bars };
      depth--;
    } else if (char === '|' && depth === 0) bars.push(i);
    i = char === '(' || char === ')' || char === '|' ? i + 1 : skipAtom(source, i);
  }
  return { end: source.length, bars };
}

/** `(?i)` and `(?s)` mid-pattern, as `(?i:…)` around each alternative to the end of their group. */
function scopeInlineFlags(source: string): string {
  const flag = /\(\?([a-z-]+)\)/g;
  for (let i = 0; i < source.length; i = skipAtom(source, i)) {
    if (source[i] !== '(') continue;
    flag.lastIndex = i;
    const set = flag.exec(source);
    if (!set || set.index !== i) continue;
    const from = i + set[0].length;
    const { end, bars } = groupRest(source, from);
    const cuts = [from, ...bars.map((bar) => bar + 1)];
    const ends = [...bars, end];
    const pieces = cuts.map(
      (cut, k) => `(?${set[1]}:${source.slice(cut, ends[k])})${k < bars.length ? '|' : ''}`,
    );
    return scopeInlineFlags(source.slice(0, i) + pieces.join('') + source.slice(end));
  }
  return source;
}

/** Go's spellings JavaScript writes another way. */
function goSyntax(source: string): string {
  let out = '';
  for (let i = 0; i < source.length; ) {
    const end = skipAtom(source, i);
    const atom = source.slice(i, end);
    // Go reads a `]` that opens a class as the character; JavaScript, as the end of the class.
    out += atom.length > 1 && atom[0] === '[' ? atom.replace(/^\[(\^?)\]/, '[$1\\]') : atom;
    i = end;
  }
  return out.replaceAll('(?P<', '(?<').replaceAll('\\z', '$').replaceAll('[:alnum:]', 'a-zA-Z0-9');
}

/** The escapes a regex names, so lint rules that flag a control character's hex escape pass. */
const NAMED_ESCAPES: Readonly<Record<number, string>> = {
  9: '\\t',
  10: '\\n',
  11: '\\v',
  12: '\\f',
  13: '\\r',
};

function escapeChar(code: number, inClass: boolean): string {
  const char = String.fromCodePoint(code);
  const named = NAMED_ESCAPES[code];
  if (named) return named;
  if (code < 0x20 || code > 0x7e) {
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, '0')}`
      : `\\u${code.toString(16).padStart(4, '0')}`;
  }
  const special = inClass ? /[\\\]^[-]/ : /[\\^$.*+?()[\]{}|/]/;
  return special.test(char) ? `\\${char}` : char;
}

/** The other case of an ASCII letter. */
function otherCase(code: number): number | undefined {
  if (code >= 0x41 && code <= 0x5a) return code + 0x20;
  if (code >= 0x61 && code <= 0x7a) return code - 0x20;
  if (
    code > 0x7f &&
    String.fromCodePoint(code).toLowerCase() !== String.fromCodePoint(code).toUpperCase()
  ) {
    throw new Error(`a non-ASCII letter under (?i): U+${code.toString(16)}`);
  }
  return undefined;
}

/** `[min, max]` with each ASCII letter in it given its other case too. */
function foldedRanges(min: number, max: number): Array<[number, number]> {
  const out: Array<[number, number]> = [[min, max]];
  for (const [from, to, shift] of [
    [0x41, 0x5a, 0x20],
    [0x61, 0x7a, -0x20],
  ] as const) {
    const lo = Math.max(min, from);
    const hi = Math.min(max, to);
    if (lo <= hi) out.push([lo + shift, hi + shift]);
  }
  if (max > 0x7f) {
    for (let code = Math.max(min, 0x80); code <= max; code++) otherCase(code);
  }
  return out;
}

interface Scope {
  ignoreCase: boolean;
  dotAll: boolean;
}

function classRange([min, max]: [number, number]): string {
  return min === max ? escapeChar(min, true) : `${escapeChar(min, true)}-${escapeChar(max, true)}`;
}

/** The ranges `held` lacks, which then holds them. */
function classRanges(
  min: number,
  max: number,
  ignoreCase: boolean,
  held: Array<[number, number]>,
): string {
  const ranges = (ignoreCase ? foldedRanges(min, max) : [[min, max] as [number, number]]).filter(
    ([lo, hi]) => !held.some(([from, to]) => from <= lo && hi <= to),
  );
  held.push(...ranges);
  return ranges.map(classRange).join('');
}

/** The code of a character both Go and JavaScript read from `raw`. */
function charCode({ raw, value }: AST.Character): number {
  if (/^\\(?![tnrfv]$|x[0-9a-fA-F]{2}$)[a-zA-Z0-9]/.test(raw)) {
    throw new Error(`Go reads ${raw} another way`);
  }
  return value;
}

/** A `-` first or last in a class makes no range, so it needs no escape. */
function plainEdges(body: string): string {
  return body.replace(/^\\-/, '-').replace(/(?<!\\)((?:\\\\)*)\\-$/, '$1-');
}

function classElement(
  element: AST.CharacterClassElement,
  ignoreCase: boolean,
  held: Array<[number, number]>,
): string {
  switch (element.type) {
    case 'Character':
      return classRanges(charCode(element), charCode(element), ignoreCase, held);
    case 'CharacterClassRange':
      return classRanges(charCode(element.min), charCode(element.max), ignoreCase, held);
    case 'CharacterSet':
      if (element.kind === 'space' && !element.negate) return GO_SPACE;
      if (element.kind === 'digit' || element.kind === 'word') return element.raw;
      throw new Error(`no Go reading of ${element.raw} in a class`);
    default:
      throw new Error(`no Go reading of ${element.raw} in a class`);
  }
}

function printAlternatives(alternatives: AST.Alternative[], scope: Scope): string {
  return alternatives
    .map((alt) => alt.elements.map((el) => printElement(el, scope)).join(''))
    .join('|');
}

function printElement(element: AST.Element, scope: Scope): string {
  switch (element.type) {
    case 'Character': {
      const code = charCode(element);
      const other = scope.ignoreCase ? otherCase(code) : undefined;
      return other === undefined
        ? escapeChar(code, false)
        : `[${escapeChar(code, true)}${escapeChar(other, true)}]`;
    }
    case 'CharacterClass': {
      const spaces = element.elements.filter(
        (part) => part.type === 'CharacterSet' && part.kind === 'space',
      );
      if (!element.negate && spaces.length === 2) return '[\\s\\S]';
      const held: Array<[number, number]> = [];
      const parts = element.elements.map((part) => classElement(part, scope.ignoreCase, held));
      return `[${element.negate ? '^' : ''}${plainEdges(parts.join(''))}]`;
    }
    case 'CharacterSet':
      if (element.kind === 'any') return scope.dotAll ? '[\\s\\S]' : '[^\\n]';
      if (element.kind === 'space') return element.negate ? `[^${GO_SPACE}]` : `[${GO_SPACE}]`;
      if (element.kind === 'digit' || element.kind === 'word') return element.raw;
      throw new Error(`no Go reading of ${element.raw}`);
    case 'Assertion':
      if (element.kind === 'start' || element.kind === 'end' || element.kind === 'word') {
        return element.raw;
      }
      throw new Error(`Go has no ${element.raw}`);
    case 'Quantifier': {
      const { min, max, greedy } = element;
      const count =
        min === 0 && max === Number.POSITIVE_INFINITY
          ? '*'
          : min === 1 && max === Number.POSITIVE_INFINITY
            ? '+'
            : min === 0 && max === 1
              ? '?'
              : max === Number.POSITIVE_INFINITY
                ? `{${min},}`
                : min === max
                  ? `{${min}}`
                  : `{${min},${max}}`;
      return `${printElement(element.element, scope)}${count}${greedy ? '' : '?'}`;
    }
    case 'Group': {
      const inner = { ...scope };
      for (const [flags, on] of [
        [element.modifiers?.add, true],
        [element.modifiers?.remove, false],
      ] as const) {
        if (flags?.ignoreCase) inner.ignoreCase = on;
        if (flags?.dotAll) inner.dotAll = on;
        if (flags?.multiline) throw new Error('no Go reading of (?m)');
      }
      return `(?:${printAlternatives(element.alternatives, inner)})`;
    }
    case 'CapturingGroup':
      return `(${element.name ? `?<${element.name}>` : ''}${printAlternatives(element.alternatives, scope)})`;
    default:
      throw new Error(`Go has no ${element.raw}`);
  }
}

/** A Go regex as a JavaScript one that matches the same text. */
function goRegex(go: string): RegExp {
  const whole = /^\(\?i\)(?!.*\(\?-?[a-z]+[):])/s.exec(go);
  const source = scopeInlineFlags(goSyntax(whole ? go.slice(whole[0].length) : go));
  const pattern: AST.Pattern = new RegExpParser({ ecmaVersion: 2025 }).parsePattern(
    source,
    0,
    source.length,
    { unicode: false, unicodeSets: false },
  );
  const printed = printAlternatives(pattern.alternatives, { ignoreCase: false, dotAll: false });
  return new RegExp(printed, whole ? 'i' : '');
}

// ── Module ───────────────────────────────────────────────────────────

/** An allowlist that can apply to a chat: one with no paths or commits it must also match. */
function chatAllowlist(list: GitleaksAllowlist): boolean {
  const needsFile = (list.paths?.length ?? 0) > 0 || (list.commits?.length ?? 0) > 0;
  const content = (list.regexes?.length ?? 0) > 0 || (list.stopwords?.length ?? 0) > 0;
  if (list.condition === 'AND' && !needsFile && content) {
    throw new Error('an allowlist needing all of its regexes and stopwords is not read');
  }
  return content && !(needsFile && list.condition === 'AND');
}

function allowlistOf(list: GitleaksAllowlist): CredentialAllowlist {
  return {
    target: list.regexTarget ?? 'secret',
    regexes: (list.regexes ?? []).map(goRegex),
    stopwords: (list.stopwords ?? []).map((word) => word.toLowerCase()),
  };
}

function ruleOf(rule: GitleaksRule): CredentialRule {
  return {
    id: rule.id,
    pattern: goRegex(rule.regex as string),
    ...(rule.secretGroup ? { secretGroup: rule.secretGroup } : {}),
    ...(rule.entropy ? { entropy: rule.entropy } : {}),
    keywords: (rule.keywords ?? []).map((word) => word.toLowerCase()),
    allowlists: (rule.allowlists ?? []).filter(chatAllowlist).map(allowlistOf),
  };
}

interface CredentialRuleSet {
  global: CredentialAllowlist;
  rules: CredentialRule[];
}

/** gitleaks' rules that read text, and what every one of them lets through. */
async function gitleaksRules(): Promise<CredentialRuleSet> {
  const config = parse(await Deno.readTextFile(SOURCE)) as unknown as GitleaksConfig;
  return {
    global: allowlistOf(config.allowlist),
    rules: config.rules
      .filter((rule) => rule.regex !== undefined && rule.path === undefined)
      .map(ruleOf),
  };
}

function allowlistText(list: CredentialAllowlist): string {
  return `{ target: ${JSON.stringify(list.target)}, regexes: [${list.regexes.join(', ')}], stopwords: ${JSON.stringify(list.stopwords)} }`;
}

function ruleText(rule: CredentialRule): string {
  const fields = [
    `id: ${JSON.stringify(rule.id)}`,
    `pattern: ${rule.pattern}`,
    ...(rule.secretGroup ? [`secretGroup: ${rule.secretGroup}`] : []),
    ...(rule.entropy ? [`entropy: ${rule.entropy}`] : []),
    `keywords: ${JSON.stringify(rule.keywords)}`,
    `allowlists: [${rule.allowlists.map(allowlistText).join(', ')}]`,
  ];
  return `  { ${fields.join(', ')} },`;
}

function moduleText({ global, rules }: CredentialRuleSet, license: string): string {
  return `/**
 * Generated by \`scripts/gen-credential-rules.ts\` from gitleaks' default rules
 * (\`scripts/gitleaks/gitleaks.toml\`). Do not edit: update the rules and run the script.
 *
 * The rules are gitleaks', under its license:
 *
${license
  .trim()
  .split('\n')
  .map((line) => ` * ${line}`.trimEnd())
  .join('\n')}
 *
 * @module
 */

import type { CredentialAllowlist, CredentialRule } from './credential-scan.ts';

/** What every rule lets through. */
const GLOBAL_ALLOWLIST: CredentialAllowlist = ${allowlistText(global)};

/** gitleaks' rules that read text, in its order. */
const CREDENTIAL_RULES: readonly CredentialRule[] = [
${rules.map(ruleText).join('\n')}
];

export { CREDENTIAL_RULES, GLOBAL_ALLOWLIST };
`;
}

if (import.meta.main) {
  const license = await Deno.readTextFile(new URL('./gitleaks/LICENSE', import.meta.url));
  await Deno.writeTextFile(OUT, moduleText(await gitleaksRules(), license));
  const fmt = new Deno.Command('npx', {
    args: ['biome', 'format', '--write', OUT.pathname],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (!(await fmt.output()).success) Deno.exit(1);
}

export { gitleaksRules, goRegex };
