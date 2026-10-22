import { assertEquals, assertThrows } from '@std/assert';
import { z } from 'zod';
import type { JsonObject } from '../../../src/kernel/json.ts';
import {
  bearer,
  callProtocol,
  checkBinding,
  createProviderRegistry,
  defineProvider,
} from '../../../src/kernel/protocols/mod.ts';
import { openRouterDecisions } from '../../../src/providers/openrouter/decisions-protocol.ts';

const router = defineProvider({
  id: 'router',
  name: 'Router',
  description: 'A decision router.',
  key: z.string(),
  authorize: bearer(),
  serves: () => [{ protocol: openRouterDecisions, baseUrl: 'https://router.test/api' }],
});

function provider() {
  const registry = createProviderRegistry();
  registry.register(router, { keySlot: 'main' });
  return registry.require('router', 'typesafe/jev-1.14');
}

function decide(request: Record<string, unknown>) {
  const sent: { url: string; headers: Headers; body: JsonObject }[] = [];
  const call = callProtocol({
    provider: provider(),
    binding: checkBinding(
      provider(),
      { protocol: 'openRouterDecisions', provider: 'router', apiId: 'typesafe/jev-1.14' },
      'decision',
    ),
    profileType: 'decision',
    vault: { main: 'k-main' },
    fetch: (input, init) => {
      sent.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as JsonObject,
      });
      return Promise.resolve(
        Response.json({ model: 'typesafe/jev-1.14', answers: { red: { type: 'noul', noul: 1 } } }),
      );
    },
    wait: async () => {},
  });
  return { sent, result: call.decide({ apiId: 'typesafe/jev-1.14', ...request } as never) };
}

const shot = { mimeType: 'image/png', data: 'iVBORw0K' } as const;
const part = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } };

Deno.test('openRouterDecisions puts each image where its reference is, and sends no assets map or opt-in', async () => {
  const { sent, result } = decide({
    state: { listing: { title: 'Sticker', photo: '<shot>' } },
    questions: {
      red: { type: 'noul', instructions: 'Is there a red square in <shot>?' },
      where: { type: 'box', instructions: '<shot>' },
      pick: {
        type: 'choice',
        instructions: 'Which?',
        criteria: { first: '<shot>', '<shot>': 'Keys stay text.' },
      },
    },
    assets: { '<shot>': shot },
  });
  assertEquals((await result).answers, { red: { type: 'noul', noul: 1 } });
  assertEquals(sent[0].url, 'https://router.test/api/alpha/decisions');
  assertEquals(
    [...sent[0].headers.keys()].filter((name) => name.startsWith('typesafe')),
    [],
  );
  assertEquals(sent[0].body, {
    model: 'typesafe/jev-1.14',
    state: { listing: { title: 'Sticker', photo: part } },
    questions: {
      red: { type: 'noul', instructions: ['Is there a red square in ', part, '?'] },
      where: { type: 'box', instructions: part },
      pick: {
        type: 'choice',
        instructions: 'Which?',
        criteria: { first: part, '<shot>': 'Keys stay text.' },
      },
    },
  });
});

Deno.test("openRouterDecisions takes no options, so TypeSafe's opt-ins are refused", () => {
  assertThrows(() =>
    checkBinding(
      provider(),
      {
        protocol: 'openRouterDecisions',
        provider: 'router',
        apiId: 'typesafe/jev-1.14',
        options: { images: true },
      },
      'decision',
    ),
  );
});
