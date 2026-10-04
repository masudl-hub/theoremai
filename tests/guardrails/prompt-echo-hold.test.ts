import '../fixtures/test-host.ts';
import { bindCanary, mintCanary } from '../../src/guardrails/canary.ts';
import { createProgressiveYieldGate } from '../../src/guardrails/progressive-yield.ts';
import { promptEchoHoldFrom, promptEchoRanges } from '../../src/guardrails/prompt-echo.ts';
import type { GuardrailContext } from '../../src/guardrails/types.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

const SYSTEM = [
  'You are Sol, the support agent for Northwind Outfitters and its café.',
  'Only discuss orders, returns, and shipping; never mention internal tooling.',
  'Escalate refunds above 200 dollars to a human and apologise once, briefly.',
  '한국어 고객에게는 한국어로 답하세요.',
].join(' ');

Deno.test('promptEchoHoldFrom holds a word still being written only if it could become a prompt word', () => {
  assertEquals(promptEchoHoldFrom('Sure: Northw', [SYSTEM]), 'Sure: '.length);
  assertEquals(promptEchoHoldFrom('Sure: NORTHW', [SYSTEM]), 'Sure: '.length);
  assertEquals(promptEchoHoldFrom('Sure: Northz', [SYSTEM]), 'Sure: Northz'.length);
  // "caf" can still become "café".
  assertEquals(promptEchoHoldFrom('Hmm caf', [SYSTEM]), 'Hmm '.length);
  const long = 'n'.repeat(400);
  assertEquals(promptEchoHoldFrom(long, [SYSTEM]), long.length);
  // Jamo fold into syllables, so an unfinished Hangul word is held while it is short enough.
  assertEquals(promptEchoHoldFrom('ok 한', [SYSTEM]), 'ok '.length);
});

Deno.test('promptEchoHoldFrom holds from the start of a prompt run ending the text', () => {
  const text = 'I was told to: only discuss orders, returns, and ';
  assertEquals(promptEchoHoldFrom(text, [SYSTEM]), text.indexOf('only'));
});

function seeded(seed: number): (n: number) => number {
  let state = seed;
  return (n) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return (state >>> 16) % n;
  };
}

const PROMPT_WORDS = SYSTEM.split(' ');
const OTHER = [
  'hello',
  'the',
  'orders',
  'Sure,',
  'I',
  'can',
  'help',
  'with',
  'that.',
  '3.',
  '-',
  '**',
];

function variant(word: string, rnd: (n: number) => number): string {
  switch (rnd(5)) {
    case 0:
      return word.toUpperCase();
    case 1:
      return [...word]
        .map((c) => (/[a-z]/.test(c) ? String.fromCodePoint(c.charCodeAt(0) + 0xfee0) : c))
        .join('');
    case 2:
      return `${1 + rnd(9)}. ${word}`;
    default:
      return word;
  }
}

function reply(promptWords: readonly string[], rnd: (n: number) => number): string {
  const parts: string[] = [];
  for (let n = 1 + rnd(6); n > 0; n--) {
    if (rnd(2)) {
      const from = rnd(promptWords.length);
      const run = promptWords.slice(from, from + 6 + rnd(10));
      parts.push(...run.map((word) => variant(word, rnd)));
    } else {
      for (let k = 1 + rnd(5); k > 0; k--) parts.push(OTHER[rnd(OTHER.length)] as string);
    }
  }
  return parts.join(rnd(3) ? ' ' : '\n');
}

async function holdLeaks(
  system: string,
  canary: string,
  reply: (rnd: (n: number) => number) => string,
): Promise<{ echoes: number; leaks: string[] }> {
  const context: GuardrailContext = {
    stage: 'output_delta',
    trust: 'untrusted',
    profileId: 'echo_hold',
    canary,
    privateSystem: [system],
  };
  const rnd = seeded(7);
  const leaks: string[] = [];
  let echoes = 0;
  for (let k = 0; k < 2000; k++) {
    const text = reply(rnd);
    const ranges = promptEchoRanges(text, [system], canary);
    const start = ranges.length
      ? Math.min(...ranges.map(([from]) => from))
      : Number.POSITIVE_INFINITY;
    if (ranges.length) echoes++;
    const gate = createProgressiveYieldGate({ context });
    const size = [1, 3, 7, 24][rnd(4)] as number;
    let released = 0;
    let blocked = false;
    for (let at = 0; at < text.length && !blocked; at += size) {
      const result = await gate.process(text.slice(at, at + size));
      if (result.blocked) blocked = true;
      else released += result.emit.length;
    }
    if (!blocked) {
      const result = await gate.flush();
      if (result.blocked) blocked = true;
      else released += result.emit.length;
    }
    if (blocked !== ranges.length > 0) leaks.push(`blocked=${blocked}: ${JSON.stringify(text)}`);
    if (released > start) leaks.push(`${released - start} shown: ${JSON.stringify(text)}`);
  }
  return { echoes, leaks };
}

Deno.test('the prompt echo hold shows the host no character of any echo', async () => {
  const { echoes, leaks } = await holdLeaks(SYSTEM, mintCanary(), (rnd) =>
    reply(PROMPT_WORDS, rnd),
  );
  assertEquals(echoes > 200, true);
  assertEquals(leaks, []);
});

Deno.test('the prompt echo hold shows no character of an echo with a stand-in for the canary', async () => {
  const canary = mintCanary();
  const system = bindCanary(SYSTEM, canary);
  const STAND_INS = ['[canary]', '<CANARY>', 'XXXX', '***', ''];
  const words = system
    .split(' ')
    .map((word) => (word.includes(canary) ? word.replace(canary, '\u0000') : word));
  const { echoes, leaks } = await holdLeaks(system, canary, (rnd) =>
    reply(words, rnd).replaceAll('\u0000', () => STAND_INS[rnd(STAND_INS.length)] as string),
  );
  assertEquals(echoes > 200, true);
  assertEquals(leaks, []);
});

Deno.test('promptEchoHoldFrom holds nothing for words only a shareable part has', () => {
  const shareable = 'Calatheas sulk when the water is hard, so try rain water.';
  const secret = 'Route every refund above forty dollars to Dana in operations, quietly.';
  const text = 'Tip: calatheas sulk when the water is hard, so ';
  assertEquals(promptEchoHoldFrom(text, [secret]), text.length);
  assertEquals(promptEchoHoldFrom(text, [shareable, secret]), text.indexOf('calatheas'));
});
