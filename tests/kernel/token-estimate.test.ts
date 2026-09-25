import { assertEquals } from '@std/assert';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import {
  loadTokenEstimator,
  type MediaPayload,
  mediaTokenFamily,
  TOKEN_TEXT_ENCODING,
} from '../../src/kernel/engine/token-estimate.ts';
import {
  loadTokenEstimator as publicLoadTokenEstimator,
  mediaTokenFamily as publicMediaTokenFamily,
  TOKEN_TEXT_ENCODING as publicTextEncoding,
} from '../../src/kernel/mod.ts';
import { bytesToBase64 } from '../../src/kernel/util/base64.ts';
import {
  jpegBytes,
  mp4Bytes,
  pcmBytes,
  pdfBytes,
  pngBytes,
  wavBytes,
  webmBytes,
  webpBytes,
} from '../fixtures/media-bytes.ts';

function inline(mimeType: string, bytes: Uint8Array): MediaPayload {
  return { mimeType, data: bytesToBase64(bytes) };
}

Deno.test('mediaTokenFamily resolves Gemini 3 text models, direct or via OpenRouter', () => {
  for (const apiId of [
    'gemini-3-flash-preview',
    'gemini-3.1-pro-preview',
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
    'gemini-3-pro',
  ]) {
    assertEquals(mediaTokenFamily({ provider: 'google', apiId }), 'gemini-3', apiId);
  }
  assertEquals(
    mediaTokenFamily({ provider: 'openrouter', apiId: 'google/gemini-3-flash-preview' }),
    'gemini-3',
  );
});

Deno.test('mediaTokenFamily is undefined for models without a verified media rule', () => {
  for (const binding of [
    { provider: 'google' as const, apiId: 'gemini-2.5-flash' },
    { provider: 'google' as const, apiId: 'gemini-3-pro-image-preview' },
    { provider: 'google' as const, apiId: 'gemini-3.1-flash-live' },
    { provider: 'openrouter' as const, apiId: 'gemini-3-flash-preview' },
    { provider: 'openrouter' as const, apiId: 'anthropic/claude-sonnet-5' },
    { provider: 'local' as const, apiId: 'gemini-3-flash-preview' },
  ]) {
    assertEquals(mediaTokenFamily(binding), undefined, `${binding.provider}:${binding.apiId}`);
  }
});

// Expected values are billed usage on gemini-3.8-flash (22/09/2026, default media resolution).
Deno.test('gemini-3 images: patch grid inside the 1120 budget, matching live counts', async () => {
  const estimator = await loadTokenEstimator();
  const live: [number, number, number][] = [
    [50, 50, 1089],
    [300, 300, 1089],
    [1024, 1024, 1089],
    [1536, 1536, 1089],
    [1920, 1080, 1100],
    [3000, 2000, 1080],
    [1000, 250, 1056],
    [4000, 1000, 1056],
    [500, 1000, 1081],
    [100, 3000, 1098],
  ];
  for (const [w, h, tokens] of live) {
    assertEquals(
      await estimator.media(inline('image/png', pngBytes(w, h)), 'gemini-3'),
      tokens,
      `${w}x${h}`,
    );
  }
  assertEquals(
    await estimator.media(inline('image/jpeg', jpegBytes(1920, 1080)), 'gemini-3'),
    1100,
  );
  assertEquals(
    await estimator.media(inline('image/webp', webpBytes('VP8X', 1000, 250)), 'gemini-3'),
    1056,
  );
});

Deno.test('gemini-3 audio: 25 tokens per decoded second', async () => {
  const estimator = await loadTokenEstimator();
  const count = (mimeType: string, bytes: Uint8Array) =>
    estimator.media(inline(mimeType, bytes), 'gemini-3');
  assertEquals(await count('audio/wav', wavBytes(5)), 125);
  assertEquals(await count('audio/x-wav', wavBytes(10)), 250);
  assertEquals(await count('audio/wav', wavBytes(2.2)), 56);
  assertEquals(await count('audio/mp4', mp4Bytes({ audio: { frames: 342 } })), 183);
  assertEquals(await count('audio/mpeg', new Uint8Array(64)), undefined);
});

Deno.test('gemini-3 raw PCM: bare audio/pcm is 16 kHz mono; L16 states rate and channels', async () => {
  const estimator = await loadTokenEstimator();
  const count = (mimeType: string, bytes: Uint8Array) =>
    estimator.media(inline(mimeType, bytes), 'gemini-3');
  assertEquals(await count('audio/pcm', pcmBytes(2, 16_000)), 50);
  assertEquals(await count('audio/L16; rate=24000; channels=2', pcmBytes(1.01, 24_000, 2)), 26);
  // Refused by Gemini, or converted with text tokens no rule reproduces.
  assertEquals(await count('audio/pcm;rate=24000', pcmBytes(2, 24_000)), undefined);
  assertEquals(await count('audio/L16; rate=16000; channels=1', pcmBytes(2, 16_000)), undefined);
  assertEquals(await count('audio/L16; rate=16000', pcmBytes(2, 16_000, 2)), undefined);
  assertEquals(await count('audio/L16; channels=2', pcmBytes(2, 16_000, 2)), undefined);
  assertEquals(await count('audio/alaw', new Uint8Array(8000)), undefined);
  assertEquals(await count('audio/mulaw', new Uint8Array(8000)), undefined);
});

Deno.test('gemini-3 video: a patch grid per rounded second plus the audio under it', async () => {
  const estimator = await loadTokenEstimator();
  const count = (mimeType: string, bytes: Uint8Array) =>
    estimator.media(inline(mimeType, bytes), 'gemini-3');
  const hd = { frames: 10, delta: 12_288, width: 1920, height: 1080 };
  assertEquals(await count('video/mp4', mp4Bytes({ video: hd })), 660);
  // 130 decoded AAC frames at 48 kHz: 2.77 s → 70.
  assertEquals(
    await count(
      'video/mp4',
      mp4Bytes({ video: hd, audio: { frames: 131, priming: 1024, lastShort: 820 } }),
    ),
    730,
  );
  assertEquals(
    await count('video/quicktime', mp4Bytes({ video: { ...hd, width: 640, height: 480 } })),
    630,
  );
  // Rounded half up: 2.5 s is 3 frames, 2.49 s is 2.
  assertEquals(await count('video/mp4', mp4Bytes({ video: { ...hd, seconds: 2.5 } })), 198);
  assertEquals(await count('video/mp4', mp4Bytes({ video: { ...hd, seconds: 2.49 } })), 132);
  // Audio past the last frame is not counted.
  assertEquals(
    await count('video/mp4', mp4Bytes({ video: { ...hd, seconds: 1 }, audio: { frames: 342 } })),
    66 + 25,
  );
  const sd = { frames: 20, frameMs: 100, width: 640, height: 360 };
  assertEquals(
    await count(
      'video/webm',
      webmBytes(101, { video: sd, codecDelayNs: 6_500_000, discardNs: 13_500_000 }),
    ),
    2 * 66 + 50,
  );
});

Deno.test('gemini-3 video unknowns: no frames, unreadable audio, unread containers', async () => {
  const estimator = await loadTokenEstimator();
  const hd = { frames: 10, delta: 12_288, width: 1920, height: 1080 };
  const unknown: MediaPayload[] = [
    inline('video/mp4', mp4Bytes({ video: { ...hd, seconds: 0.49 } })),
    inline(
      'video/webm',
      webmBytes(100, {
        duration: 2,
        laced: true,
        video: { frames: 20, frameMs: 100, width: 640, height: 360 },
      }),
    ),
    inline('video/x-msvideo', new TextEncoder().encode('RIFF\0\0\0\0AVI LIST')),
    inline('video/mp4', new Uint8Array(64)),
  ];
  for (const payload of unknown) {
    assertEquals(await estimator.media(payload, 'gemini-3'), undefined, payload.mimeType);
  }
});

Deno.test('gemini-3 PDF: 520 tokens per page', async () => {
  const estimator = await loadTokenEstimator();
  assertEquals(
    await estimator.media(inline('application/pdf', await pdfBytes(1)), 'gemini-3'),
    520,
  );
  assertEquals(
    await estimator.media(inline('application/pdf', await pdfBytes(3)), 'gemini-3'),
    1560,
  );
  assertEquals(
    await estimator.media(
      inline('application/pdf', await pdfBytes(2, { layout: 'objectStream' })),
      'gemini-3',
    ),
    1040,
  );
});

Deno.test('gemini-3 text documents count as their UTF-8 text', async () => {
  const estimator = await loadTokenEstimator();
  const utf8 = (text: string) => new TextEncoder().encode(text);
  for (const [mimeType, text] of [
    ['text/plain', 'Water the fern when the top inch is dry.'],
    ['text/markdown', '# Care\n\n- light: bright, indirect'],
    ['application/json', '{"plant":"fern","water":"weekly"}'],
    ['text/x-python', 'def water(days):\n    return days % 7 == 0\n'],
    ['text/csv', 'plant,water\nfern,weekly\n'],
  ]) {
    assertEquals(
      await estimator.media(inline(mimeType, utf8(text)), 'gemini-3'),
      encode(text).length,
      mimeType,
    );
  }
});

Deno.test('gemini-3 unknowns: converted documents, unreadable bytes, file references', async () => {
  const estimator = await loadTokenEstimator();
  const unknown: MediaPayload[] = [
    inline('text/md', new TextEncoder().encode('# Care')),
    inline('application/x-python', new TextEncoder().encode('print(1)')),
    inline('text/plain', new Uint8Array([0xff, 0xfe, 0x00])),
    inline('image/png', new Uint8Array(8)),
    inline('application/pdf', new TextEncoder().encode('%PDF-1.7\n%%EOF\n')),
    { mimeType: 'image/png', uri: 'https://example.com/files/abc' },
  ];
  for (const payload of unknown) {
    assertEquals(await estimator.media(payload, 'gemini-3'), undefined, payload.mimeType);
  }
});

Deno.test('media without a family is unknown, never a borrowed rate', async () => {
  const estimator = await loadTokenEstimator();
  assertEquals(
    await estimator.media(inline('image/png', pngBytes(1024, 1024)), undefined),
    undefined,
  );
  assertEquals(await estimator.media(inline('audio/wav', wavBytes(5)), undefined), undefined);
  assertEquals(
    await estimator.media(inline('text/plain', new TextEncoder().encode('fern')), undefined),
    undefined,
  );
});

Deno.test('parts and messages count text with o200k and report unknown media', async () => {
  const estimator = await loadTokenEstimator();
  const image = { type: 'image' as const, ...inline('image/png', pngBytes(1920, 1080)) };
  const video = { type: 'video' as const, ...inline('video/mp4', new Uint8Array(16)) };
  assertEquals(
    await estimator.parts([{ type: 'text', text: 'hello there' }, image, video], 'gemini-3'),
    { tokens: encode('hello there').length + 1100, unknownMedia: 1 },
  );
  assertEquals(
    await estimator.parts([{ type: 'text', text: 'hello there' }, image, video], undefined),
    { tokens: encode('hello there').length, unknownMedia: 2 },
  );
  assertEquals(
    await estimator.messages(
      [
        { role: 'user', content: 'look at this' },
        { role: 'user', parts: [image] },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"fern"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', name: 'search', content: 'results' },
      ],
      'gemini-3',
    ),
    {
      tokens:
        encode('look at this').length +
        1100 +
        encode('search').length +
        encode('{"q":"fern"}').length +
        encode('results').length,
      unknownMedia: 0,
    },
  );
  assertEquals(estimator.text(''), 0);
});

Deno.test('public barrel re-exports the token estimator', () => {
  assertEquals(publicLoadTokenEstimator, loadTokenEstimator);
  assertEquals(publicMediaTokenFamily, mediaTokenFamily);
  assertEquals(publicTextEncoding, TOKEN_TEXT_ENCODING);
  assertEquals(TOKEN_TEXT_ENCODING, 'o200k_base');
});
