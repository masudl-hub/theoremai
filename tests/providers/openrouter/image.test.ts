import { assertEquals } from '@std/assert';
import { PUBLIC_GENERIC } from '../../../src/guardrails/error.ts';
import type { ImageResponseFormat, ProviderCompleteRequest } from '../../../src/kernel/types.ts';
import {
  buildImageHeaders,
  buildInterleavedChatPayload,
  createImageProvider,
  fetchImageAsBase64,
  markdownImageUrls,
  mediaFromImagesResponse,
  OPENROUTER_IMAGE_TOOL,
  plainTextFromContent,
  streamImage,
  yieldImagesEndpoint,
  yieldInterleavedChat,
} from '../../../src/providers/openrouter/image.ts';
import {
  attachImagePins,
  buildImagesPayload,
  imageToolParameters,
  outputFormatFromMime,
  wireInputReference,
  wireInputReferences,
} from '../../../src/providers/openrouter/openai/image-payload.ts';

const IMAGE: ImageResponseFormat = {
  type: 'image',
  mimeType: 'image/png',
  aspectRatio: '16:9',
  size: '2K',
  includeText: false,
};

function createMockImageRequest(
  overrides: Partial<ProviderCompleteRequest> = {},
): ProviderCompleteRequest {
  return {
    model: 'seedream',
    apiId: 'bytedance-seed/seedream-4.5',
    thinking: 'none',
    summaries: undefined,
    maxOutputTokens: 4096,
    temperature: 1,
    builtins: [],
    system: 'Generate one image.',
    input: [{ type: 'text', text: 'a red panda astronaut' }],
    structured: null,
    image: IMAGE,
    ...overrides,
  };
}

Deno.test('buildImagesPayload maps kernel image pins to OpenAI-compat body', () => {
  const req = createMockImageRequest({
    input: [
      { type: 'text', text: 'paint this' },
      { type: 'image', mimeType: 'image/jpeg', data: 'abc123' },
    ],
  });
  assertEquals(buildImagesPayload(req), {
    model: 'bytedance-seed/seedream-4.5',
    prompt: 'paint this',
    aspect_ratio: '16:9',
    resolution: '2K',
    output_format: 'png',
    input_references: [
      {
        type: 'image_url',
        image_url: { url: 'data:image/jpeg;base64,abc123' },
      },
    ],
  });
});

Deno.test('outputFormatFromMime normalizes jpeg aliases', () => {
  assertEquals(outputFormatFromMime('image/jpeg'), 'jpeg');
  assertEquals(outputFormatFromMime('image/jpg'), 'jpeg');
  assertEquals(outputFormatFromMime('image/webp'), 'webp');
});

Deno.test('buildInterleavedChatPayload attaches the OpenRouter image generation tool', () => {
  const req = createMockImageRequest({
    image: { ...IMAGE, includeText: true },
  });
  const payload = buildInterleavedChatPayload(req);
  assertEquals(payload.stream, false);
  assertEquals(payload.tools, [
    {
      type: 'openrouter:image_generation',
      parameters: {
        aspect_ratio: '16:9',
        resolution: '2K',
        output_format: 'png',
      },
    },
  ]);
});

Deno.test('mediaFromImagesResponse reads b64_json and media_type', () => {
  assertEquals(
    mediaFromImagesResponse({ data: [{ b64_json: 'abc', media_type: 'image/webp' }] }, 'image/png'),
    { mimeType: 'image/webp', data: 'abc' },
  );
});

Deno.test('mediaFromImagesResponse returns null when mime cannot be resolved', () => {
  assertEquals(mediaFromImagesResponse({ data: [{ b64_json: 'abc' }] }), null);
});

Deno.test('markdownImageUrls extracts https image links from assistant markdown', () => {
  const urls = markdownImageUrls(
    "Here's the scene:\n\n![Generated image](https://images.openrouter.ai/gen.png)\n\nDone.",
  );
  assertEquals(urls, ['https://images.openrouter.ai/gen.png']);
});

Deno.test('plainTextFromContent strips markdown image syntax', () => {
  assertEquals(
    plainTextFromContent("Here's the scene:\n\n![Generated image](https://example.com/a.png)"),
    "Here's the scene:",
  );
});

Deno.test('streamImage yields error when apiKey is missing', async () => {
  const events = [];
  for await (const event of streamImage(createMockImageRequest(), { apiKey: '' })) {
    events.push(event);
  }
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
  assertEquals((events[0] as { error: string }).error, PUBLIC_GENERIC);
});

Deno.test('streamImage yields error on empty prompt text', async () => {
  const events = [];
  for await (const event of streamImage(createMockImageRequest({ input: [] }), { apiKey: 'key' })) {
    events.push(event);
  }
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
  assertEquals((events[0] as { error: string }).error, PUBLIC_GENERIC);
});

Deno.test('yieldImagesEndpoint maps /images JSON to media and tokens', async () => {
  const mockFetch: typeof fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [{ b64_json: 'img-bytes', media_type: 'image/png' }],
          usage: { prompt_tokens: 4, completion_tokens: 100, total_tokens: 104 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

  const events = [];
  for await (const event of yieldImagesEndpoint(
    createMockImageRequest(),
    { apiKey: 'key', fetch: mockFetch },
    'key',
  )) {
    events.push(event);
  }
  assertEquals(
    events.map((event) => event.type),
    ['media', 'tokens', 'done'],
  );
  assertEquals(events[0]?.media, { mimeType: 'image/png', data: 'img-bytes' });
});

Deno.test('yieldImagesEndpoint yields error on HTTP failure', async () => {
  const mockFetch: typeof fetch = () => Promise.resolve(new Response('nope', { status: 502 }));
  const events = [];
  for await (const event of yieldImagesEndpoint(
    createMockImageRequest(),
    { apiKey: 'key', fetch: mockFetch },
    'key',
  )) {
    events.push(event);
  }
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
  assertEquals((events[0] as { error: string }).error, PUBLIC_GENERIC);
});

Deno.test('yieldInterleavedChat yields text, fetched media, tokens, and done', async () => {
  const imageBytes = new Uint8Array([137, 80, 78, 71]);
  const mockFetch: typeof fetch = (input) => {
    const url = String(input);
    if (url.includes('/chat/completions')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content:
                    "Here's your scene:\n\n![Generated image](https://images.openrouter.ai/gen.png)",
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 200, total_tokens: 210 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    if (url.includes('images.openrouter.ai/gen.png')) {
      return Promise.resolve(
        new Response(imageBytes, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }),
      );
    }
    return Promise.resolve(new Response('', { status: 404 }));
  };

  const events = [];
  for await (const event of yieldInterleavedChat(
    createMockImageRequest({ image: { ...IMAGE, includeText: true } }),
    { apiKey: 'key', fetch: mockFetch },
    'key',
  )) {
    events.push(event);
  }
  assertEquals(
    events.map((event) => event.type),
    ['text', 'media', 'tokens', 'done'],
  );
  assertEquals(events[0]?.text, "Here's your scene:");
  assertEquals(events[1]?.media?.mimeType, 'image/png');
});

Deno.test('fetchImageAsBase64 returns base64 image bytes', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const mockFetch: typeof fetch = () =>
    Promise.resolve(
      new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/jpeg' } }),
    );
  const media = await fetchImageAsBase64('https://example.com/a.jpg', mockFetch);
  assertEquals(media?.mimeType, 'image/jpeg');
  assertEquals(media?.data, btoa(String.fromCharCode(...bytes)));
});

Deno.test('createImageProvider exposes complete()', () => {
  const provider = createImageProvider({ apiKey: 'key' });
  assertEquals(typeof provider.complete, 'function');
  assertEquals(OPENROUTER_IMAGE_TOOL, 'openrouter:image_generation');
  const headers = buildImageHeaders('test-key', { apiKey: 'test-key' });
  assertEquals(headers.Authorization, 'Bearer test-key');
});

Deno.test('wireInputReferences ignores non-image parts', () => {
  const ref = wireInputReference({ type: 'image', mimeType: 'image/png', data: 'abc' });
  assertEquals(ref.type, 'image_url');

  const dummyPayload: Record<string, unknown> = {};
  attachImagePins(dummyPayload, IMAGE);
  assertEquals(dummyPayload.aspect_ratio, '16:9');

  assertEquals(
    wireInputReferences([
      { type: 'text', text: 'hello' },
      { type: 'audio', mimeType: 'audio/wav', data: 'x' },
    ]),
    [],
  );
});

Deno.test('imageToolParameters maps image pins for chat tool parameters', () => {
  assertEquals(imageToolParameters(IMAGE), {
    aspect_ratio: '16:9',
    resolution: '2K',
    output_format: 'png',
  });
});

Deno.test('imageToolParameters and buildImagesPayload omit unset aspect and size', () => {
  const image: ImageResponseFormat = {
    type: 'image',
    mimeType: 'image/jpeg',
    includeText: false,
  };
  assertEquals(imageToolParameters(image), { output_format: 'jpeg' });
  const payload = buildImagesPayload(
    createMockImageRequest({
      image,
      input: [{ type: 'text', text: 'a fox' }],
    }),
  );
  assertEquals(payload.model, 'bytedance-seed/seedream-4.5');
  assertEquals(payload.prompt, 'a fox');
  assertEquals(payload.output_format, 'jpeg');
  assertEquals(Object.hasOwn(payload, 'aspect_ratio'), false);
  assertEquals(Object.hasOwn(payload, 'resolution'), false);
});
