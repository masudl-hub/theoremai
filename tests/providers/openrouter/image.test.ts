import { assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { TheoremError } from '../../../src/guardrails/error.ts';
import type { ImageResponseFormat, ProviderCompleteRequest } from '../../../src/kernel/types.ts';
import {
  buildImageHeaders,
  buildInterleavedChatPayload,
  createImageProvider,
  imagesFromChatMessage,
  imagesFromImagesBody,
  OPENROUTER_IMAGE_TOOL,
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

// Response shapes follow the OpenRouter probe of 23/09/2026 (seedream-4.5 on
// `/images`, gemini-3.1-flash-lite with the image tool on chat); values are synthetic.
Deno.test('imagesFromImagesBody reads every b64_json entry with its media_type', () => {
  assertEquals(
    imagesFromImagesBody({
      data: [
        { b64_json: 'abc', media_type: 'image/webp' },
        { b64_json: 'def', media_type: 'image/jpeg' },
      ],
    }),
    [
      { mimeType: 'image/webp', data: 'abc' },
      { mimeType: 'image/jpeg', data: 'def' },
    ],
  );
});

Deno.test('imagesFromImagesBody skips an entry without a media_type', () => {
  assertEquals(imagesFromImagesBody({ data: [{ b64_json: 'abc' }] }), []);
});

Deno.test('imagesFromChatMessage reads base64 data urls from message.images', () => {
  assertEquals(
    imagesFromChatMessage({
      role: 'assistant',
      content: 'A leaf.',
      images: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      ],
    }),
    [{ mimeType: 'image/png', data: 'iVBORw0K' }],
  );
});

Deno.test('streamImage yields error when apiKey is missing', async () => {
  const events = [];
  for await (const event of streamImage(createMockImageRequest(), { apiKey: '' })) {
    events.push(event);
  }
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
  assertEquals((events[0] as { errorKind: string }).errorKind, 'auth');
});

Deno.test('streamImage yields error on empty prompt text', async () => {
  const events = [];
  for await (const event of streamImage(createMockImageRequest({ input: [] }), { apiKey: 'key' })) {
    events.push(event);
  }
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
  assertEquals((events[0] as { errorKind: string }).errorKind, 'request');
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

  const taped: Record<string, unknown>[] = [];
  const events = [];
  for await (const event of yieldImagesEndpoint(
    createMockImageRequest({ tapUpstream: (row) => taped.push(row) }),
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
  assertEquals(
    taped.map((row) => row.eventType ?? 'body'),
    ['http_request', 'http_response', 'body'],
  );
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
  assertEquals((events[0] as { errorKind: string }).errorKind, 'unavailable');
});

Deno.test('yieldInterleavedChat yields text, media, tokens and done, taping each row', async () => {
  const body = {
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
  const mockFetch: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  const taped: Record<string, unknown>[] = [];
  const events = [];
  for await (const event of yieldInterleavedChat(
    createMockImageRequest({
      image: { ...IMAGE, includeText: true },
      tapUpstream: (row) => taped.push(row),
    }),
    { apiKey: 'key', fetch: mockFetch },
    'key',
  )) {
    events.push(event);
  }
  assertEquals(
    events.map((event) => event.type),
    ['text', 'media', 'tokens', 'done'],
  );
  assertEquals(events[0]?.text, 'A leaf.');
  assertEquals(events[1]?.media, { mimeType: 'image/png', data: 'iVBORw0K' });
  assertEquals(
    taped.map((row) => row.eventType ?? 'body'),
    ['http_request', 'http_response', 'body'],
  );
  assertEquals(taped[2], body);
});

Deno.test('yieldInterleavedChat without message.images is an error', async () => {
  const mockFetch: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: 'No image.' } }] }), {
        status: 200,
      }),
    );
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
    ['text', 'error'],
  );
});

Deno.test('createImageProvider exposes complete()', () => {
  const provider = createImageProvider({ apiKey: 'key' });
  assertEquals(typeof provider.complete, 'function');
  assertEquals(OPENROUTER_IMAGE_TOOL, 'openrouter:image_generation');
  const headers = buildImageHeaders('test-key', { apiKey: 'test-key' });
  assertEquals(headers.Authorization, 'Bearer test-key');
});

Deno.test('wireInputReferences wires image parts and skips the text prompt', () => {
  const ref = wireInputReference({ type: 'image', mimeType: 'image/png', data: 'abc' });
  assertEquals(ref.type, 'image_url');

  const dummyPayload: Record<string, unknown> = {};
  attachImagePins(dummyPayload, IMAGE);
  assertEquals(dummyPayload.aspect_ratio, '16:9');

  assertEquals(wireInputReferences([{ type: 'text', text: 'hello' }]), []);
  assertEquals(
    wireInputReferences([
      { type: 'text', text: 'hello' },
      { type: 'image', mimeType: 'image/png', data: 'abc' },
    ]),
    [ref],
  );
});

Deno.test('wireInputReferences refuses media /images cannot take', () => {
  for (const part of [
    { type: 'audio', mimeType: 'audio/wav', data: 'x' },
    { type: 'video', mimeType: 'video/mp4', data: 'x' },
    { type: 'document', mimeType: 'application/pdf', data: 'x' },
  ] as const) {
    const error = assertThrows(() => wireInputReferences([part]), TheoremError);
    assertEquals(error.kind, 'unsupported');
    assertStringIncludes(error.message, part.mimeType);
  }
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
