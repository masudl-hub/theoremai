import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { sumTokens } from '../../src/kernel/engine/usage.ts';

Deno.test('sumTokens returns undefined for no calls', () => {
  assertEquals(sumTokens([]), undefined);
});

Deno.test('sumTokens adds counts and shares across calls', () => {
  assertEquals(
    sumTokens([
      { input: 100, output: 30, thinking: 20, cached: 40, total: 130 },
      { input: 150, output: 10, toolUse: 5, cacheWrite: 60, total: 160 },
    ]),
    {
      input: 250,
      output: 40,
      thinking: 20,
      toolUse: 5,
      cached: 40,
      cacheWrite: 60,
      total: 290,
    },
  );
});

Deno.test('sumTokens marks a side estimated when any call estimated it', () => {
  assertEquals(
    sumTokens([
      { input: 100, output: 30, total: 130 },
      { input: 80, output: 9, total: 89, estimated: ['input'], unknownMedia: { input: 1 } },
      {
        input: 70,
        output: 12,
        total: 82,
        estimated: ['input', 'output'],
        unknownMedia: { input: 2, output: 1 },
      },
    ]),
    {
      input: 250,
      output: 51,
      total: 301,
      estimated: ['input', 'output'],
      unknownMedia: { input: 3, output: 1 },
    },
  );
});

Deno.test('sumTokens sums cost and marks it partial when some calls reported none', () => {
  const all = sumTokens([
    { input: 1, output: 1, total: 2, cost: { usd: 0.25, upstreamUsd: 0.2 } },
    { input: 1, output: 1, total: 2, cost: { usd: 0.5 } },
  ]);
  assertEquals(all?.cost, { usd: 0.75, upstreamUsd: 0.2 });

  const partial = sumTokens([
    { input: 1, output: 1, total: 2, cost: { usd: 0.25 } },
    { input: 1, output: 1, total: 2 },
  ]);
  assertEquals(partial?.cost, { usd: 0.25, partial: true });

  const nested = sumTokens([
    { input: 1, output: 1, total: 2, cost: { usd: 0.25, partial: true } },
    { input: 1, output: 1, total: 2, cost: { usd: 0.5 } },
  ]);
  assertEquals(nested?.cost, { usd: 0.75, partial: true });

  assertEquals(sumTokens([{ input: 1, output: 1, total: 2 }])?.cost, undefined);
});

Deno.test('sumTokens sums a modality only when every call reported it', () => {
  const total = sumTokens([
    { input: 20, output: 5, total: 25, byModality: { input: { text: 12, image: 8 } } },
    { input: 30, output: 5, total: 35, byModality: { input: { text: 30 }, output: { text: 5 } } },
  ]);
  assertEquals(total?.byModality, { input: { text: 42 } });
  assertEquals(
    sumTokens([
      { input: 20, output: 5, total: 25, byModality: { input: { text: 20 } } },
      { input: 30, output: 5, total: 35 },
    ])?.byModality,
    undefined,
  );
});

Deno.test('sumTokens sums grounding per tool over the calls that reported it', () => {
  const total = sumTokens([
    {
      input: 20,
      output: 5,
      total: 25,
      grounding: [{ type: 'google_search', count: 2, searchQueryCount: 2 }],
    },
    { input: 30, output: 5, total: 35 },
    {
      input: 30,
      output: 5,
      total: 35,
      grounding: [
        { type: 'google_search', count: 1 },
        { type: 'google_maps', count: 1, searchQueryCount: 1 },
      ],
    },
  ]);
  assertEquals(total?.grounding, [
    { type: 'google_search', count: 3 },
    { type: 'google_maps', count: 1, searchQueryCount: 1 },
  ]);
});
