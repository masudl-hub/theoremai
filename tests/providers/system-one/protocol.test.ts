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

function post(options: JsonObject, request: Record<string, unknown>, apiId = 'jev-1.14.0') {
  const sent: { headers: Headers; body: JsonObject }[] = [];
  const registry = createProviderRegistry();
  registry.register(decider, { keySlot: 'main' });
  const provider = registry.require('decider', apiId);
  const call = callProtocol({
    provider,
    binding: checkBinding(
      provider,
      { protocol: 'systemOne', provider: 'decider', apiId, options },
      'decision',
    ),
    profileType: 'decision',
    vault: { main: 'k-main' },
    fetch: (_input, init) => {
      sent.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as JsonObject,
      });
      return Promise.resolve(
        Response.json({ model: apiId, answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
      );
    },
    wait: async () => {},
  });
  const call_ = { apiId, state: 'x', questions: {}, ...request };
  return { sent, result: call.decide(call_ as unknown as Parameters<typeof call.decide>[0]) };
}

const picture = { 'img-1': { mimeType: 'image/png', data: 'iVBORw0K' } };
const boxQuestion = { find: { type: 'box', instructions: 'The cup in `img-1`.' } };

Deno.test('systemOne sends no danger-zone header unless the binding opts in', async () => {
  const plain = post({}, {});
  await plain.result;
  assertEquals(plain.sent[0]?.headers.get('TypeSafe-Danger-Zone-Long-Context'), null);
  assertEquals(plain.sent[0]?.headers.get('TypeSafe-Danger-Zone-Images'), null);

  const long = post({ longContext: true }, {});
  await long.result;
  assertEquals(long.sent[0]?.headers.get('TypeSafe-Danger-Zone-Long-Context'), 'true');
  assertEquals(long.sent[0]?.headers.get('TypeSafe-Danger-Zone-Images'), null);
});

Deno.test('systemOne sends images as assets with the images header', async () => {
  const { sent, result } = post({ images: true }, { assets: picture, questions: boxQuestion });
  await result;
  assertEquals(sent[0]?.headers.get('TypeSafe-Danger-Zone-Images'), 'true');
  assertEquals(sent[0]?.body.assets, {
    'img-1': { type: 'image', format: 'png', data_base64: 'iVBORw0K' },
  });
});

Deno.test('systemOne refuses images and box questions the binding has not opted into', async () => {
  await assertRejects(() => post({}, { assets: picture }).result, TheoremError, 'images: true');
  await assertRejects(
    () => post({}, { questions: boxQuestion }).result,
    TheoremError,
    'images: true',
  );
});

Deno.test('systemOne refuses a box question on a pinned Jev 1.13 only', async () => {
  await assertRejects(
    () => post({ images: true }, { questions: boxQuestion }, 'jev-1.13.0').result,
    TheoremError,
    'jev-1.13.0',
  );
  await post({ images: true }, { questions: boxQuestion }, 'jev-latest').result;
});

Deno.test('systemOne options are strict', () => {
  const registry = createProviderRegistry();
  registry.register(decider, { keySlot: 'main' });
  const provider = registry.require('decider', 'jev-1');
  try {
    checkBinding(
      provider,
      { protocol: 'systemOne', provider: 'decider', apiId: 'jev-1', options: { image: true } },
      'decision',
    );
    throw new Error('expected a refusal');
  } catch (error) {
    assertEquals(error instanceof TheoremError, true);
  }
});
