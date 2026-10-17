import { assertEquals, assertMatch, assertRejects } from '@std/assert';
import { z } from 'zod';
import { TheoremError } from '../../../src/guardrails/error.ts';
import type { JsonObject } from '../../../src/kernel/json.ts';
import {
  bearer,
  callProtocol,
  checkBinding,
  createProviderRegistry,
  defineProvider,
  type ProtocolEvent,
  type ProtocolRequest,
} from '../../../src/kernel/protocols/mod.ts';
import { openRouterImages } from '../../../src/providers/openrouter/images-protocol.ts';
import { failureOf } from '../../fixtures/failure.ts';

const router = defineProvider({
  id: 'router',
  name: 'Router',
  description: 'A gateway with image generation.',
  key: z.string(),
  authorize: bearer(),
  serves: () => [{ protocol: openRouterImages, baseUrl: 'https://router.test/api/v1' }],
});

function run(
  reply: JsonObject,
  image: JsonObject,
  at: { text?: string; vault?: Record<string, string> } = {},
) {
  const sent: { url: string; body: JsonObject }[] = [];
  const taped: JsonObject[] = [];
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
    vault: at.vault ?? { main: 'k-main' },
    fetch: (input, init) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)) as JsonObject });
      return Promise.resolve(Response.json(reply));
    },
    wait: async () => {},
    tapUpstream: (row) => taped.push(row),
  });
  const request = {
    system: '',
    input: [{ type: 'text', text: at.text ?? 'A tram in Lisbon.' }],
    builtins: [],
    structured: null,
    image,
  } as unknown as ProtocolRequest;
  const seen: ProtocolEvent[] = [];
  const events = (async () => {
    for await (const event of call.complete(request)) seen.push(event);
    return seen;
  })();
  return { sent, taped, seen, events };
}

Deno.test('openRouterImages posts /images for the picture alone', async () => {
  const { sent, taped, events } = run(
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
  assertEquals(
    taped.map((row) => row.eventType ?? 'body'),
    ['http_request', 'http_response', 'body'],
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
  assertEquals(
    (sent[0]?.body.tools as JsonObject[] | undefined)?.[0]?.type,
    'openrouter:image_generation',
  );
  assertEquals(out[1], { type: 'media', media: { mimeType: 'image/png', data: 'AAAA' } });
  assertEquals(
    out.map((event) => event.type),
    ['text', 'media', 'done'],
  );
});

Deno.test('openRouterImages ends a reply with no image as an error', async () => {
  assertMatch(failureOf(await run({ data: [] }, {}).events).message, /no image/);
});

Deno.test('openRouterImages sends its pins on the chat tool, and reads the usage and tapes the body', async () => {
  const reply = {
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'A leaf.',
          images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } }],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 200, total_tokens: 210 },
  };
  const { sent, taped, events } = run(reply, {
    type: 'image',
    mimeType: 'image/png',
    aspectRatio: '16:9',
    resolution: '2K',
    includeText: true,
  });
  const out = await events;
  assertEquals(sent[0]?.body.stream, false);
  assertEquals(sent[0]?.body.provider, { require_parameters: true });
  assertEquals(sent[0]?.body.tools, [
    {
      type: 'openrouter:image_generation',
      parameters: { aspect_ratio: '16:9', resolution: '2K', output_format: 'png' },
    },
  ]);
  assertEquals(
    out.map((event) => event.type),
    ['text', 'media', 'tokens', 'done'],
  );
  assertEquals(out[0], { type: 'text', text: 'A leaf.' });
  assertEquals(
    taped.map((row) => row.eventType ?? 'body'),
    ['http_request', 'http_response', 'body'],
  );
  assertEquals(taped[2], reply);
});

Deno.test('openRouterImages ends a chat reply with no image as an error, after its text', async () => {
  const { seen, events } = run(
    { choices: [{ message: { content: 'No image.' } }] },
    { includeText: true },
  );
  assertMatch(failureOf(await events).message, /no image/);
  assertEquals(seen[0], { type: 'text', text: 'No image.' });
  assertEquals(
    seen.map((event) => event.type),
    ['text', 'error'],
  );
});

Deno.test('openRouterImages refuses an empty prompt before any call', async () => {
  const { sent, events } = run({ data: [] }, {}, { text: '' });
  const error = await assertRejects(() => events, TheoremError);
  assertEquals(error.kind, 'request');
  assertEquals(sent.length, 0);
});

Deno.test('an empty key slot is refused as auth before any call', async () => {
  const { sent, events } = run({ data: [] }, {}, { vault: { main: '' } });
  const error = await assertRejects(() => events, TheoremError);
  assertEquals(error.kind, 'auth');
  assertEquals(sent.length, 0);
});
