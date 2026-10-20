import { assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { TheoremError } from '../../../src/guardrails/error.ts';
import type { ImageResponseFormat, ModelRequest } from '../../../src/kernel/types.ts';
import {
  imagesFromChatMessage,
  imagesFromImagesBody,
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
  resolution: '2K',
  includeText: false,
};

function createMockImageRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
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

Deno.test('buildImagesPayload sends no system prompt or history', () => {
  const body = JSON.stringify(
    buildImagesPayload(
      createMockImageRequest({
        system: 'SYSTEM-MARKER',
        history: [{ role: 'user', content: 'HISTORY-MARKER' }],
      }),
    ),
  );
  assertEquals(body.includes('SYSTEM-MARKER') || body.includes('HISTORY-MARKER'), false);
});

Deno.test('outputFormatFromMime normalizes jpeg aliases', () => {
  assertEquals(outputFormatFromMime('image/jpeg'), 'jpeg');
  assertEquals(outputFormatFromMime('image/jpg'), 'jpeg');
  assertEquals(outputFormatFromMime('image/webp'), 'webp');
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

Deno.test('wireInputReferences passes an http(s) reference through and refuses other schemes', () => {
  const url = 'https://example.com/style.png';
  assertEquals(wireInputReferences([{ type: 'image', mimeType: 'image/png', uri: url }]), [
    { type: 'image_url', image_url: { url } },
  ]);
  const error = assertThrows(
    () => wireInputReferences([{ type: 'image', mimeType: 'image/png', uri: 'gs://bucket/a.png' }]),
    TheoremError,
  );
  assertEquals(error.kind, 'unsupported');
  assertStringIncludes(error.message, 'http(s)');
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

const PINNED: ImageResponseFormat = {
  type: 'image',
  includeText: false,
  quality: 'high',
  background: 'transparent',
  n: 2,
  seed: 7,
  outputCompression: 80,
};

Deno.test('buildImagesPayload sends quality, background, n, seed, and output_compression', () => {
  const payload = buildImagesPayload(createMockImageRequest({ image: PINNED }));
  assertEquals(payload.quality, 'high');
  assertEquals(payload.background, 'transparent');
  assertEquals(payload.n, 2);
  assertEquals(payload.seed, 7);
  assertEquals(payload.output_compression, 80);
});

Deno.test('buildImagesPayload omits every unset image pin', () => {
  const payload = buildImagesPayload(
    createMockImageRequest({ image: { type: 'image', includeText: false } }),
  );
  for (const key of ['quality', 'background', 'n', 'seed', 'output_compression']) {
    assertEquals(Object.hasOwn(payload, key), false);
  }
});

Deno.test('imageToolParameters sends quality, background, and compression but refuses n and seed', () => {
  assertEquals(imageToolParameters({ ...PINNED, n: undefined, seed: undefined }), {
    quality: 'high',
    background: 'transparent',
    output_compression: 80,
  });
  assertThrows(() => imageToolParameters(PINNED), TheoremError);
});
