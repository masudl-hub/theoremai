import { addGivenDestinations, turnDestinations } from '../../src/guardrails/destinations.ts';
import { detectAt } from '../../src/guardrails/detect-at.ts';
import { resolveDetect } from '../../src/guardrails/detectors.ts';
import { injectionSpans } from '../../src/guardrails/injection.ts';
import { freshPattern, HEX_BLOB, PIPE_SEPARATED } from '../../src/guardrails/injection-patterns.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { OMIT_SENSITIVE } from '../../src/observability/spans.ts';

/** The same strings on every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function matchesOf(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => `${match.index}:${match[0]}`);
}

for (const [pattern, alphabet] of [
  [HEX_BLOB, '0aF9g \n\t x'],
  [PIPE_SEPARATED, 'abZ|_1 |x'],
] as const) {
  Deno.test(`the scan for ${pattern.source} finds exactly what its source finds`, () => {
    const random = seeded(7);
    for (let round = 0; round < 20_000; round++) {
      let text = '';
      const length = 1 + Math.floor(random() * 40);
      for (let at = 0; at < length; at++) text += alphabet[Math.floor(random() * alphabet.length)];
      const source = new RegExp(pattern.source, pattern.flags);
      assertEquals(matchesOf(text, freshPattern(pattern)), matchesOf(text, source));
    }
  });
}

Deno.test('a run of tens of millions of characters is read without overflowing the regex engine', () => {
  assertEquals(injectionSpans('a'.repeat(8_000_000)), []);
  assertEquals(freshPattern(PIPE_SEPARATED).exec('ab|'.repeat(6_000_000))?.[0].length, 17_999_999);
  assertEquals(freshPattern(HEX_BLOB).exec('ab '.repeat(11_000_000))?.[0].length, 33_000_000);
});

Deno.test('redact takes out each of hundreds of thousands of matches', () => {
  const text = '123-45-6789 '.repeat(300_000);
  const read = detectAt(text, 'user', resolveDetect('redact'));
  assertEquals((read.text ?? '').split(OMIT_SENSITIVE).length - 1, 300_000);
});

Deno.test('a line of a hundred thousand keys is read with the allowlists once', () => {
  const text = 'sk-abcdef0123456789abcdef0123456789 '.repeat(100_000);
  const read = detectAt(text, 'user', resolveDetect({ credentials: { action: 'redact' } }));
  assertEquals((read.text ?? '').split(OMIT_SENSITIVE).length - 1, 100_000);
});

Deno.test('a text with hundreds of thousands of emails names each destination once', () => {
  const turn = turnDestinations();
  addGivenDestinations(turn, 'write to ops@vendor.example '.repeat(200_000));
  assertEquals(turn.given.size, 1);
});
