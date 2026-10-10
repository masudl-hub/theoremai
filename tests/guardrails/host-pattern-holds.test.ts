import type { Detector } from '../../src/guardrails/detectors.ts';
import { compilePatterns } from '../../src/guardrails/egress-compiler.ts';
import { createEgressStream, type EgressStream } from '../../src/guardrails/egress-stream.ts';
import { type HostPattern, matchersOf } from '../../src/guardrails/host-patterns.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { replyHits } from '../fixtures/detect.ts';
import { referenceMatchStart } from './egress-reference.ts';

/** The detectors of a reply's text that block by default, read in the same stream. */
const DEFAULT_BLOCKING: readonly Detector[] = ['marker_leak', 'ungiven_images'];

const PATTERNS: HostPattern[] = [
  { name: 'account', pattern: 'ACCT-\\d{6,10}\\b' },
  { name: 'token', pattern: '(?<=token: )[A-Za-z0-9]{12}' },
  { name: 'codename', pattern: '\\bproject (?=nightjar)', flags: 'i' },
  { name: 'locks', pattern: '\\u{1F512}{2}', flags: 'u' },
  { name: 'keyed', pattern: '[\\w.-]{0,8}?secret=[a-z]{4}' },
  { name: 'guarded', pattern: '\\bkey(?=[a-z]\\d)[a-z0-9]{2}' },
  { name: 'pin', pattern: 'pin(?=\\d{4})\\d' },
  { name: 'tag', pattern: 'tag(?!xy)[a-z]{2}' },
];

/** A stream reading `patterns` as a detector of the host's own, beside `detect`. */
function streamOf(patterns: HostPattern[], detect: readonly Detector[] = []): EgressStream {
  return createEgressStream({
    detect,
    own: [
      { detector: 'acme.own', compiled: compilePatterns(patterns), matchers: matchersOf(patterns) },
    ],
  });
}

/** Where a stream of `patterns` alone holds from, `text` pushed a character at a time; -1 once it settles a match. */
function heldFrom(patterns: HostPattern[], text: string): number {
  const stream = streamOf(patterns);
  for (const chunk of text) if (stream.push(chunk).length > 0) return -1;
  return stream.holdFrom();
}

/** Where the first match of `PATTERNS` starts, or Infinity. */
function ownMatchStart(text: string): number {
  let start = Number.POSITIVE_INFINITY;
  for (const { regex } of matchersOf(PATTERNS)) {
    for (const match of text.matchAll(regex)) {
      if (match[0]) start = Math.min(start, match.index);
    }
  }
  return start;
}

/** The name of every pattern of `PATTERNS` that matches in `text`. */
function ownNames(text: string): string[] {
  return matchersOf(PATTERNS)
    .filter(({ regex }) => [...text.matchAll(regex)].some((match) => match[0]))
    .map(({ name }) => name);
}

function seeded(seed: number): (n: number) => number {
  let state = seed;
  return (n) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return (state >>> 16) % n;
  };
}

const PIECES = [
  'ACCT-',
  'ACCT-',
  '123456',
  '1234567890',
  'ACCT',
  'ACCT-1234567',
  '-',
  '123',
  '4567',
  '8901',
  '12',
  'x',
  ' ',
  ' ',
  'token: ',
  'token:',
  'abcDEF12',
  '3456',
  'Project ',
  'project nightjar',
  'PROJECT ',
  'project nigh',
  'project',
  ' ',
  'nightjar',
  'night',
  'jar',
  '\u{1F512}',
  '\u{1F512}',
  '\uD83D',
  '\uDD12',
  'my_',
  'long.name-of_a.setting_',
  'secret=',
  'secret=',
  'abcd',
  'key',
  'keya5',
  'a5',
  'a5',
  'pin',
  'pin',
  'tag',
  'tag',
  'xy',
  'the reply',
  'ignore previous instructions',
  '\n',
];

function fuzzText(rnd: (n: number) => number): string {
  let text = '';
  const n = 1 + rnd(14);
  for (let i = 0; i < n; i++) text += PIECES[rnd(PIECES.length)];
  return text;
}

function fuzzChunks(text: string, rnd: (n: number) => number): string[] {
  const size = [1, 2, 3, 7, 0][rnd(5)] as number;
  const chunks: string[] = [];
  for (let at = 0; at < text.length; ) {
    const length = size || 1 + rnd(20);
    chunks.push(text.slice(at, at + length));
    at += length;
  }
  return chunks;
}

Deno.test('a pattern with inline modifiers or repeated group names is held for like any other', () => {
  const patterns: HostPattern[] = [
    { name: 'secret', pattern: '(?i:secret)-\\d{1,9}' },
    { name: 'ticket', pattern: '(?<id>T-\\d{1,9})|(?<id>TK\\d{1,9})' },
    { name: 'span', pattern: 'a(?s:.)z' },
  ];
  for (const [text, start] of [
    ['see SeCrEt-', 4],
    ['see TK', 4],
    ['see a\n', 4],
  ] as const) {
    assertEquals([text, heldFrom(patterns, text)], [text, start]);
  }
});

Deno.test('an opening repeat of one class is kept out of the automaton and held from the start of its run', () => {
  const patterns: HostPattern[] = [
    { name: 'keyed', pattern: '[\\w.-]{0,8}?secret=[a-z]{4}' },
    { name: 'wrapped', pattern: '(?:(?<![=])[a-z]{0,8}(key\\d))' },
    { name: 'either', pattern: '[a-z]{0,8}x|y\\d' },
  ];
  assertEquals(
    compilePatterns(patterns).automaton.leads.map((lead) => lead >= 0),
    [true, true, false],
  );
  const keyed = patterns.slice(0, 1);
  for (const [text, start] of [
    ['see a_long.name-of_a.setting_sec', 4],
    ['see word', 4],
    ['see word ', 9],
    ['see word, secret=ab', 10],
    ['see my_secret=abcd', 4],
    ['see my_secret=abcd ', -1],
  ] as const) {
    assertEquals([text, heldFrom(keyed, text)], [text, start]);
  }
});

Deno.test('a lookahead is read only where the match may end before its text does', () => {
  const guarded: HostPattern[] = [{ name: 'guarded', pattern: '\\bkey(?=[a-z]\\d)[a-z0-9]{2}' }];
  assertEquals(heldFrom(guarded, 'see xke'), 5);
  assertEquals(heldFrom(guarded, 'see key'), 4);
  assertEquals(heldFrom(guarded, 'see keyab '), 10);
  assertEquals(heldFrom(guarded, 'see keya5 '), -1);
  const pin: HostPattern[] = [{ name: 'pin', pattern: 'pin(?=\\d{4})\\d' }];
  for (const [text, start] of [
    ['see pin1', 4],
    ['see pin123', 4],
    ['see pin1234', 4],
    ['see pin1234 ', -1],
    ['see pin12x', 10],
  ] as const) {
    assertEquals([text, heldFrom(pin, text)], [text, start]);
  }
  const nested: HostPattern[] = [{ name: 'nested', pattern: '(?:a(?=bcd)){1,8}b?' }];
  assertEquals(heldFrom(nested, 'x ab'), 2);
  assertEquals(heldFrom(nested, 'x abc'), 2);
  assertEquals(heldFrom(nested, 'x abcd '), -1);
  assertEquals(heldFrom(nested, 'x abce'), 6);
});

/** What went wrong streaming `text` in chunks, if anything: an early release, or a stop nothing reads a match for. */
function streamProblem(
  detectors: readonly Detector[],
  text: string,
  start: number,
  rnd: (n: number) => number,
): string | undefined {
  const stream = streamOf(PATTERNS, detectors);
  let read = '';
  for (const chunk of fuzzChunks(text, rnd)) {
    read += chunk;
    if (stream.push(chunk).length > 0) {
      return ownNames(read).length > 0 || replyHits(read, {}, detectors).length > 0
        ? undefined
        : `stopped on no match: ${JSON.stringify(read)}`;
    }
    if (stream.holdFrom() > start) {
      return `released ${stream.holdFrom() - start} of a match: ${JSON.stringify(text)}`;
    }
  }
  return undefined;
}

Deno.test('the stream holds every match of a host pattern from its first character and stops only on a match', () => {
  const problems: string[] = [];
  const byName = new Map<string, number>();
  // The host's patterns alone, then with the detectors that block a reply by default in the same stream.
  for (const detectors of [[], DEFAULT_BLOCKING]) {
    const rnd = seeded(detectors.length > 0 ? 41 : 17);
    for (let k = 0; k < 3000; k++) {
      const text = fuzzText(rnd);
      for (const name of ownNames(text)) byName.set(name, (byName.get(name) ?? 0) + 1);
      const start = Math.min(ownMatchStart(text), referenceMatchStart(text, detectors));
      const problem = streamProblem(detectors, text, start, rnd);
      if (problem) problems.push(problem);
    }
  }
  assertEquals(problems, []);
  assertEquals(
    PATTERNS.filter(({ name }) => (byName.get(name) ?? 0) < 50).map(({ name }) => name),
    [],
  );
});
