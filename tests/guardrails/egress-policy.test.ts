import { assertEquals, assertThrows } from '@std/assert';
import { main } from '../../src/cli/index.ts';
import { compileEgressRules } from '../../src/guardrails/compile-egress.ts';
import { collectEgressHits, DEFAULT_CHECKS, NO_CHECKS } from '../../src/guardrails/egress.ts';
import { egressPolicy } from '../../src/guardrails/egress-policy.ts';
import type { EgressRule } from '../../src/guardrails/egress-rules.ts';
import { createEgressStream } from '../../src/guardrails/egress-stream.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import { createProgressiveYieldGate } from '../../src/guardrails/progressive-yield.ts';
import { EGRESS_RULES } from '../../src/guardrails/rules.ts';
import type { GuardrailContext, Verdict } from '../../src/guardrails/types.ts';
import { referenceMatchStart } from './egress-reference.ts';

const RULES: EgressRule[] = [
  { rule: 'acme.account', pattern: /ACCT-\d{6,10}\b/ },
  { rule: 'acme.token', pattern: /(?<=token: )[A-Za-z0-9]{12}/, severity: 'medium' },
  { rule: 'acme.codename', pattern: /\bproject (?=nightjar)/i },
  { rule: 'acme.locks', pattern: /\u{1F512}{2}/u },
  { rule: 'acme.keyed', pattern: /[\w.-]{0,8}?secret=[a-z]{4}/ },
  { rule: 'acme.guarded', pattern: /\bkey(?=[a-z]\d)[a-z0-9]{2}/ },
  { rule: 'acme.pin', pattern: /pin(?=\d{4})\d/ },
  { rule: 'acme.tag', pattern: /tag(?!xy)[a-z]{2}/ },
];
const COMPILED = compileEgressRules(RULES);

const context: GuardrailContext = { stage: 'output_delta', trust: 'untrusted', profileId: 'acme' };

function verdict(enforce: ReturnType<typeof egressPolicy>, text: string): Verdict {
  return enforce({ text }, context) as Verdict;
}

/** Where the first host match starts, or Infinity. */
function hostMatchStart(text: string): number {
  let start = Number.POSITIVE_INFINITY;
  for (const { pattern } of RULES) {
    for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
      if (match[0]) start = Math.min(start, match.index);
    }
  }
  return start;
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

Deno.test('egressPolicy blocks on each host rule with its severity', () => {
  const enforce = egressPolicy({ rules: RULES, compiled: COMPILED, bundled: false });
  const cases: [string, string, string][] = [
    ['your account is ACCT-1234567.', 'acme.account', 'high'],
    ['token: abcDEF123456', 'acme.token', 'medium'],
    ['Project nightjar ships', 'acme.codename', 'high'],
    ['locked \u{1F512}\u{1F512}', 'acme.locks', 'high'],
    ['my_secret=abcd', 'acme.keyed', 'high'],
    ['the keya5', 'acme.guarded', 'high'],
    ['pin1234', 'acme.pin', 'high'],
    ['tagxz', 'acme.tag', 'high'],
  ];
  for (const [text, rule, severity] of cases) {
    const result = verdict(enforce, text);
    assertEquals(result.action, 'block', text);
    const hits = result.action === 'block' ? result.hits : [];
    assertEquals(
      hits.map((hit) => [hit.rule, hit.severity]),
      [[rule, severity]],
    );
  }
  for (const text of [
    'ACCT-12345',
    'ACCT-1234567x',
    'token abcDEF123456',
    'project falcon',
    '\u{1F512}',
    'secret=abc',
    'monkeya5',
    'keyab',
    'pin123',
    'tagxy',
  ]) {
    assertEquals(verdict(enforce, text).action, 'allow', text);
  }
});

Deno.test('egressPolicy runs the bundled policy too unless told not to', () => {
  const echo = 'Sure: <user_data>the note</user_data>';
  assertEquals(collectEgressHits(echo).length > 0, true);
  const withBundled = verdict(egressPolicy({ rules: RULES, compiled: COMPILED }), echo);
  assertEquals(withBundled.action, 'block');
  const hostOnly = egressPolicy({ rules: RULES, compiled: COMPILED, bundled: false });
  assertEquals(verdict(hostOnly, echo).action, 'allow');
  const canary = 'CANARY-7f3a';
  const leak = hostOnly({ text: `the key is ${canary}` }, { ...context, canary }) as Verdict;
  assertEquals(leak.action === 'block' && leak.hits.map((hit) => hit.rule), [EGRESS_RULES.canary]);
});

Deno.test('egressPolicy refuses a table compiled from other rules or by another compiler', () => {
  const changed = RULES.map((rule, i) => (i === 0 ? { ...rule, pattern: /ACCT-\d{7}/ } : rule));
  assertThrows(
    () => egressPolicy({ rules: changed, compiled: COMPILED }),
    TheoremError,
    'egress-compile',
  );
  assertThrows(
    () => egressPolicy({ rules: RULES, compiled: { ...COMPILED, compiler: 0 } }),
    TheoremError,
    'egress-compile',
  );
});

Deno.test('egress rules need distinct ids of their own and a pattern the stream can hold for', () => {
  const bad: [EgressRule[], string][] = [
    [[{ rule: '', pattern: /a/ }], 'non-empty'],
    [[{ rule: 'egress.mine', pattern: /a/ }], 'bundled policy'],
    [
      [
        { rule: 'acme.a', pattern: /a/ },
        { rule: 'acme.a', pattern: /b/ },
      ],
      'listed twice',
    ],
    [[{ rule: 'acme.sticky', pattern: /a/y }], 'sticky'],
    [[{ rule: 'acme.repeat', pattern: /(\w+) \1/ }], 'no automaton'],
  ];
  for (const [rules, message] of bad) {
    assertThrows(() => compileEgressRules(rules), TheoremError, message);
  }
});

Deno.test('a pattern with inline modifiers or repeated group names is held for like any other', () => {
  const rules: EgressRule[] = [
    { rule: 'acme.secret', pattern: /(?i:secret)-\d+/ },
    { rule: 'acme.ticket', pattern: /(?<id>T-\d+)|(?<id>TK\d+)/ },
    { rule: 'acme.span', pattern: /a(?s:.)z/ },
  ];
  const { automaton } = compileEgressRules(rules);
  const host = {
    automaton,
    rules: rules.map(({ rule, pattern }) => ({ rule, pattern, severity: 'high' as const })),
  };
  for (const [text, start] of [
    ['see SeCrEt-', 4],
    ['see TK', 4],
    ['see a\n', 4],
  ] as const) {
    const stream = createEgressStream({ checks: NO_CHECKS, host });
    for (const chunk of text) stream.push(chunk);
    assertEquals(stream.holdFrom(), start, text);
  }
});

/** Where a stream of `rules` alone holds from, `text` pushed a character at a time. */
function heldFrom(rules: EgressRule[], text: string): number {
  const { automaton } = compileEgressRules(rules);
  const host = {
    automaton,
    rules: rules.map(({ rule, pattern }) => ({ rule, pattern, severity: 'high' as const })),
  };
  const stream = createEgressStream({ checks: NO_CHECKS, host });
  for (const chunk of text) if (stream.push(chunk).length > 0) return -1;
  return stream.holdFrom();
}

Deno.test('an opening repeat of one class is kept out of the automaton and held from the start of its run', () => {
  const rules: EgressRule[] = [
    { rule: 'acme.keyed', pattern: /[\w.-]{0,8}?secret=[a-z]{4}/ },
    { rule: 'acme.wrapped', pattern: /(?:(?<![=])[a-z]*(key\d))/ },
    { rule: 'acme.only', pattern: /[a-z]*/ },
    { rule: 'acme.either', pattern: /[a-z]*x|y\d/ },
  ];
  assertEquals(
    compileEgressRules(rules).automaton.leads.map((lead) => lead >= 0),
    [true, true, false, false],
  );
  const keyed = rules.slice(0, 1);
  for (const [text, start] of [
    ['see a_long.name-of_a.setting_sec', 4],
    ['see word', 4],
    ['see word ', 9],
    ['see word, secret=ab', 10],
    ['see my_secret=abcd', 4],
    ['see my_secret=abcd ', -1],
  ] as const) {
    assertEquals(heldFrom(keyed, text), start, text);
  }
});

Deno.test('a lookahead is read only where the match may end before its text does', () => {
  const guarded: EgressRule[] = [{ rule: 'acme.guarded', pattern: /\bkey(?=[a-z]\d)[a-z0-9]{2}/ }];
  assertEquals(heldFrom(guarded, 'see xke'), 5);
  assertEquals(heldFrom(guarded, 'see key'), 4);
  assertEquals(heldFrom(guarded, 'see keyab '), 10);
  assertEquals(heldFrom(guarded, 'see keya5 '), -1);
  const pin: EgressRule[] = [{ rule: 'acme.pin', pattern: /pin(?=\d{4})\d/ }];
  for (const [text, start] of [
    ['see pin1', 4],
    ['see pin123', 4],
    ['see pin1234', 4],
    ['see pin1234 ', -1],
    ['see pin12x', 10],
  ] as const) {
    assertEquals(heldFrom(pin, text), start, text);
  }
  const nested: EgressRule[] = [{ rule: 'acme.nested', pattern: /(?:a(?=bcd))+b?/ }];
  assertEquals(heldFrom(nested, 'x ab'), 2);
  assertEquals(heldFrom(nested, 'x abc'), 2);
  assertEquals(heldFrom(nested, 'x abcd '), -1);
  assertEquals(heldFrom(nested, 'x abce'), 6);
});

const HOST_SCAN = {
  automaton: COMPILED.automaton,
  rules: RULES.map(({ rule, pattern, severity }) => ({
    rule,
    pattern,
    severity: severity ?? 'high',
  })),
};

/** What went wrong streaming `text` in chunks, if anything: an early release or a block the policy does not make. */
function streamProblem(
  enforce: ReturnType<typeof egressPolicy>,
  bundled: boolean,
  text: string,
  start: number,
  rnd: (n: number) => number,
): string | undefined {
  const stream = createEgressStream({
    checks: bundled ? DEFAULT_CHECKS : NO_CHECKS,
    host: HOST_SCAN,
  });
  let read = '';
  for (const chunk of fuzzChunks(text, rnd)) {
    read += chunk;
    if (stream.push(chunk).length > 0) {
      return verdict(enforce, read).action === 'block'
        ? undefined
        : `blocked what the policy passes: ${JSON.stringify(read)}`;
    }
    if (stream.holdFrom() > start) {
      return `released ${stream.holdFrom() - start} of a match: ${JSON.stringify(text)}`;
    }
  }
  return undefined;
}

Deno.test('the host-rule stream holds every host match from its first character and blocks only what the policy blocks', () => {
  const problems: string[] = [];
  const byRule = new Map<string, number>();
  for (const bundled of [false, true]) {
    const enforce = egressPolicy({ rules: RULES, compiled: COMPILED, bundled });
    const rnd = seeded(bundled ? 41 : 17);
    for (let k = 0; k < 3000; k++) {
      const text = fuzzText(rnd);
      const hostStart = hostMatchStart(text);
      const start = bundled
        ? Math.min(hostStart, referenceMatchStart(text, DEFAULT_CHECKS, undefined, []))
        : hostStart;
      const result = verdict(enforce, text);
      const hits = result.action === 'block' ? result.hits : [];
      for (const hit of hits) byRule.set(hit.rule, (byRule.get(hit.rule) ?? 0) + 1);
      if (hits.length > 0 !== start < Number.POSITIVE_INFINITY) {
        problems.push(`reference disagrees with the policy: ${JSON.stringify(text)}`);
      }
      const problem = streamProblem(enforce, bundled, text, start, rnd);
      if (problem) problems.push(problem);
    }
  }
  assertEquals(problems, []);
  assertEquals(
    RULES.filter(({ rule }) => (byRule.get(rule) ?? 0) < 50).map(({ rule }) => rule),
    [],
  );
});

Deno.test('the gate releases a host-rule reply up to the match and no further', async () => {
  const enforce = egressPolicy({ rules: RULES, compiled: COMPILED, bundled: false });
  const gate = createProgressiveYieldGate({ context, enforce });
  let emitted = '';
  let blocked = false;
  for (const chunk of ['Your number is ', 'ACC', 'T-12', '3456', '7 thanks']) {
    const result = await gate.process(chunk);
    if (result.blocked) {
      blocked = true;
      break;
    }
    emitted += result.emit;
  }
  assertEquals(blocked, true);
  assertEquals(emitted, 'Your number is ');
});

Deno.test('agents egress-compile writes a module egressPolicy loads', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/rules.ts`,
      "export const acme = [{ rule: 'acme.account', pattern: /ACCT-\\d{6,10}\\b/ }];\n",
    );
    await main([
      'egress-compile',
      `${dir}/rules.ts`,
      '--export',
      'acme',
      '--out',
      `${dir}/compiled.ts`,
    ]);
    const { acme } = await import(`file://${dir}/rules.ts`);
    const { compiledEgressRules } = await import(`file://${dir}/compiled.ts`);
    const enforce = egressPolicy({ rules: acme, compiled: compiledEgressRules });
    assertEquals(verdict(enforce, 'ACCT-1234567').action, 'block');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
