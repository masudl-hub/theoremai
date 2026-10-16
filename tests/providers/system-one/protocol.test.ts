import { assertEquals, assertRejects } from '@std/assert';
import { z } from 'zod';
import { TheoremError } from '../../../src/guardrails/error.ts';
import type { JsonObject } from '../../../src/kernel/json.ts';
import {
  bearer,
  callProtocol,
  checkBinding,
  createProviderRegistry,
  defineProvider,
} from '../../../src/kernel/protocols/mod.ts';
import { systemOne } from '../../../src/providers/system-one/protocol.ts';

const decider = defineProvider({
  id: 'decider',
  name: 'Decider',
  description: 'A decision service.',
  key: z.string(),
  authorize: bearer(),
  prices: { checked: '2026-10-16', models: { 'jev-*': { input: 0.042, output: 0 } } },
  serves: () => [{ protocol: systemOne, baseUrl: 'https://decider.test/v1' }],
});

function decide(reply: JsonObject, apiId = 'jev-1') {
  const sent: { url: string; body: JsonObject }[] = [];
  const registry = createProviderRegistry();
  registry.register(decider, { keySlot: 'main' });
  const provider = registry.require('decider', apiId);
  const call = callProtocol({
    provider,
    binding: checkBinding(
      provider,
      { protocol: 'systemOne', provider: 'decider', apiId },
      'decision',
    ),
    profileType: 'decision',
    vault: { main: 'k-main' },
    fetch: (input, init) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)) as JsonObject });
      return Promise.resolve(Response.json(reply));
    },
    wait: async () => {},
  });
  const request = {
    apiId,
    state: { city: 'Lisbon' },
    questions: { rain: { type: 'boolean' } },
  } as unknown as Parameters<typeof call.decide>[0];
  return { sent, result: call.decide(request) };
}

Deno.test('systemOne posts the state and questions and prices a reply that has no cost', async () => {
  const { sent, result } = decide({
    model: 'jev-1',
    answers: { rain: { type: 'noul', noul: 1 } },
    usage: { input_tokens: 1_000_000, output_tokens: 3 },
  });
  assertEquals(await result, {
    model: 'jev-1',
    answers: { rain: { type: 'noul', noul: 1 } },
    usage: { inputTokens: 1_000_000, outputTokens: 3, costUsd: 0.042, estimated: true },
  });
  assertEquals(sent[0], {
    url: 'https://decider.test/v1/systemone',
    body: { model: 'jev-1', state: { city: 'Lisbon' }, questions: { rain: { type: 'boolean' } } },
  });
});

Deno.test('systemOne keeps a reported cost and refuses a reply it cannot read', async () => {
  const reported = decide({
    model: 'jev-1',
    answers: {},
    usage: { input_tokens: 10, output_tokens: 1, cost: 0.5 },
  });
  assertEquals((await reported.result).usage, { inputTokens: 10, outputTokens: 1, costUsd: 0.5 });
  await assertRejects(() => decide({ answers: {} }).result, TheoremError, 'cannot read');
});
