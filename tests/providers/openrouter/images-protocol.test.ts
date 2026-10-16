import { assertEquals, assertRejects } from '@std/assert';
import { z } from 'zod';
import { TheoremError } from '../../../src/guardrails/error.ts';
import {
  bearer,
  callProtocol,
  checkBinding,
  createProviderRegistry,
  defineProvider,
  type ProtocolEvent,
  type TurnRequest,
} from '../../../src/kernel/protocols/mod.ts';
import type { JsonObject } from '../../../src/kernel/provider-contract.ts';
import { openRouterImages } from '../../../src/providers/openrouter/images-protocol.ts';

const router = defineProvider({
  id: 'router',
  name: 'Router',
  description: 'A gateway with image generation.',
  key: z.string(),
  authorize: bearer(),
  serves: () => [{ protocol: openRouterImages, baseUrl: 'https://router.test/api/v1' }],
});

function run(reply: JsonObject, image: JsonObject) {
  const sent: { url: string; body: JsonObject }[] = [];
  const registry = createProviderRegistry();
  registry.register(router, { keySlot: 'main' });
  const provider = registry.require('router', 'img-1');
  const call = callProtocol({
    provider,
    binding: checkBinding(
      provider,
      { protocol: 'openRouterImages', provider: 'router', apiId: 'img-1' },
      'image',
    ),
    profileType: 'image',
    vault: { main: 'k-main' },
    fetch: async (input, init) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)) as JsonObject });
      return Response.json(reply);
    },
    wait: async () => {},
  });
  const request = {
    system: '',
    input: [{ type: 'text', text: 'A tram in Lisbon.' }],
    builtins: [],
    structured: null,
    image,
  } as unknown as TurnRequest;
  return { sent, events: collect(call.complete(request)) };
}

async function collect(events: AsyncIterable<ProtocolEvent>): Promise<ProtocolEvent[]> {
  const out: ProtocolEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

Deno.test('openRouterImages posts /images for the picture alone', async () => {
  const { sent, events } = run(
    {
      data: [{ b64_json: 'AAAA', media_type: 'image/png' }],
      usage: { input_tokens: 5, output_tokens: 9 },
    },
    { aspectRatio: '16:9' },
  );
  const out = await events;
  assertEquals(sent[0]?.url, 'https://router.test/api/v1/images');
  assertEquals(sent[0]?.body, {
    model: 'img-1',
    prompt: 'A tram in Lisbon.',
    aspect_ratio: '16:9',
  });
  assertEquals(
    out.map((event) => event.type),
    ['media', 'tokens', 'done'],
  );
});

Deno.test('openRouterImages posts the chat path with its tool when text is wanted', async () => {
  const { sent, events } = run(
    {
      choices: [
        {
          message: {
            content: 'Here it is.',
            images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
          },
          finish_reason: 'stop',
        },
      ],
    },
    { includeText: true },
  );
  const out = await events;
  assertEquals(sent[0]?.url, 'https://router.test/api/v1/chat/completions');
  assertEquals((sent[0]?.body.tools as JsonObject[])[0]?.type, 'openrouter:image_generation');
  assertEquals(out[1], { type: 'media', media: { mimeType: 'image/png', data: 'AAAA' } });
  assertEquals(
    out.map((event) => event.type),
    ['text', 'media', 'done'],
  );
});

Deno.test('openRouterImages refuses a reply with no image', async () => {
  await assertRejects(() => run({ data: [] }, {}).events, TheoremError, 'no image');
});
