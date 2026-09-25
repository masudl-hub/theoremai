import { assertAlmostEquals, assertEquals } from '@std/assert';
import { audioSeconds } from '../../src/kernel/engine/media-probe/audio.ts';
import { imageSize } from '../../src/kernel/engine/media-probe/image.ts';
import { pdfPageCount } from '../../src/kernel/engine/media-probe/pdf.ts';
import { videoInfo } from '../../src/kernel/engine/media-probe/video.ts';
import {
  adtsBytes,
  aiffBytes,
  flacBytes,
  gifBytes,
  heicBytes,
  jpegBytes,
  mp3Bytes,
  mp4Bytes,
  oggBytes,
  pdfBytes,
  pngBytes,
  wavBytes,
  webmBytes,
  webpBytes,
} from '../fixtures/media-bytes.ts';

Deno.test('imageSize reads PNG, JPEG, GIF, and every WebP layout', () => {
  assertEquals(imageSize(pngBytes(1920, 1080)), { width: 1920, height: 1080 });
  assertEquals(imageSize(jpegBytes(640, 480)), { width: 640, height: 480 });
  assertEquals(imageSize(gifBytes(320, 200)), { width: 320, height: 200 });
  assertEquals(imageSize(webpBytes('VP8 ', 800, 600)), { width: 800, height: 600 });
  assertEquals(imageSize(webpBytes('VP8L', 1000, 250)), { width: 1000, height: 250 });
  assertEquals(imageSize(webpBytes('VP8X', 4000, 1000)), { width: 4000, height: 1000 });
});

Deno.test('imageSize skips JPEG DHT and restart markers before the frame header', () => {
  const bytes = jpegBytes(100, 3000);
  assertEquals(bytes.includes(0xc4), true);
  assertEquals(imageSize(bytes), { width: 100, height: 3000 });
});

Deno.test('imageSize is undefined for unknown, truncated, or zero-sized images', () => {
  assertEquals(imageSize(new Uint8Array()), undefined);
  assertEquals(imageSize(new TextEncoder().encode('not an image at all')), undefined);
  assertEquals(imageSize(pngBytes(1920, 1080).subarray(0, 20)), undefined);
  assertEquals(imageSize(jpegBytes(640, 480).subarray(0, 30)), undefined);
  assertEquals(imageSize(pngBytes(0, 1080)), undefined);
  assertEquals(imageSize(gifBytes(320, 0)), undefined);
});

Deno.test('imageSize reads the primary item of a tiled HEIC', () => {
  assertEquals(imageSize(heicBytes(4032, 3024)), { width: 4032, height: 3024 });
  assertEquals(imageSize(heicBytes(1000, 250)), { width: 1000, height: 250 });
});

Deno.test('imageSize is undefined for a HEIC whose primary item is cropped', () => {
  assertEquals(imageSize(heicBytes(4032, 3024, { clap: true })), undefined);
  assertEquals(imageSize(heicBytes(4032, 3024).subarray(0, 60)), undefined);
});

Deno.test('audioSeconds reads WAV from fmt byte rate and data size', () => {
  assertEquals(audioSeconds(wavBytes(5)), 5);
  assertEquals(audioSeconds(wavBytes(2.5, { rate: 24_000, channels: 2 })), 2.5);
  assertEquals(audioSeconds(wavBytes(1, { extra: true })), 1);
});

Deno.test('audioSeconds reads AIFF and FLAC stream headers', () => {
  assertEquals(audioSeconds(aiffBytes(7.3, 22_050)), 7.3);
  assertEquals(audioSeconds(flacBytes(7.3, 44_100)), 7.3);
  assertEquals(audioSeconds(flacBytes(2, 48_000, { id3: true })), 2);
});

Deno.test('audioSeconds reads the last granule of the first Ogg stream', () => {
  assertEquals(audioSeconds(oggBytes('opus', 7.3, 48_000, 312)), 7.3);
  assertEquals(audioSeconds(oggBytes('vorbis', 4, 44_100)), 4);
  assertEquals(audioSeconds(oggBytes('flac', 3, 48_000)), 3);
});

Deno.test('audioSeconds sums WebM Opus packets less CodecDelay and DiscardPadding', () => {
  assertAlmostEquals(audioSeconds(webmBytes(365)) ?? 0, 7.3, 1e-9);
  // Stated Duration (ms-rounded, before trimming) loses to the decoded packets.
  assertEquals(
    audioSeconds(
      webmBytes(501, { duration: 10.008, codecDelayNs: 6_500_000, discardNs: 13_500_000 }),
    ),
    10,
  );
  assertEquals(
    audioSeconds(webmBytes(366, { codecDelayNs: 6_500_000, discardNs: 13_500_000 })),
    7.3,
  );
});

Deno.test('audioSeconds falls back to WebM Duration only when packets cannot be read', () => {
  assertEquals(audioSeconds(webmBytes(365, { duration: 7.3, laced: true })), 7.3);
  assertEquals(audioSeconds(webmBytes(365, { laced: true })), undefined);
});

Deno.test('audioSeconds reads MP4 decoded samples from stts and fragments', () => {
  const frames = (n: number) => (n * 1024) / 48_000;
  assertEquals(audioSeconds(mp4Bytes({ audio: { frames: 342 } })), frames(342));
  assertEquals(audioSeconds(mp4Bytes({ audio: { frames: 342 }, version: 1 })), frames(342));
  assertEquals(audioSeconds(mp4Bytes({ audio: { frames: 343 }, fragmented: true })), frames(343));
});

Deno.test('audioSeconds drops the MP4 leading skip but decodes the last AAC frame whole', () => {
  // ffmpeg shape: 1024 priming samples, the final stts entry shortened to mark padding,
  // and an edit that ends inside that final frame.
  const ffmpeg = { frames: 131, priming: 1024, lastShort: 820 };
  assertEquals(audioSeconds(mp4Bytes({ audio: ffmpeg })), (130 * 1024) / 48_000);
  assertEquals(audioSeconds(mp4Bytes({ audio: ffmpeg, version: 1 })), (130 * 1024) / 48_000);
});

Deno.test('audioSeconds is undefined for MP4 edits it cannot decode exactly', () => {
  // The edit ends before the last frame starts: the trimmed frames are not decoded.
  assertEquals(
    audioSeconds(mp4Bytes({ audio: { frames: 100, priming: 1024, seconds: 1 } })),
    undefined,
  );
  // Two non-empty edits.
  assertEquals(
    audioSeconds(
      mp4Bytes({
        audio: {
          frames: 100,
          edits: [
            [500, 0],
            [500, 48_000],
          ],
        },
      }),
    ),
    undefined,
  );
  // An empty edit (a gap) before the one that plays is not a second edit.
  assertEquals(
    audioSeconds(
      mp4Bytes({
        audio: {
          frames: 100,
          edits: [
            [250, -1],
            [2133, 1024],
          ],
        },
      }),
    ),
    (100 * 1024 - 1024) / 48_000,
  );
});

Deno.test('audioSeconds reads MP3 frame-count and LAME trim tags, else walks every frame', () => {
  const v1 = (frames: number) => (frames * 1152) / 44_100;
  assertEquals(audioSeconds(mp3Bytes(300, { tag: 'xing', id3: true })), v1(300));
  assertEquals(audioSeconds(mp3Bytes(300, { tag: 'vbri' })), v1(300));
  assertEquals(
    audioSeconds(
      mp3Bytes(384, { tag: 'xing', lame: { encoder: 'Lavc63.1.', delay: 576, padding: 792 } }),
    ),
    10,
  );
  assertEquals(
    audioSeconds(
      mp3Bytes(300, { tag: 'xing', lame: { encoder: 'LAME3.100', delay: 576, padding: 1000 } }),
    ),
    (300 * 1152 - 1576) / 44_100,
  );
  // An unrecognized encoder string carries no trustworthy delay fields.
  assertEquals(
    audioSeconds(
      mp3Bytes(300, { tag: 'xing', lame: { encoder: 'GOGO', delay: 576, padding: 1000 } }),
    ),
    v1(300),
  );
  assertAlmostEquals(
    audioSeconds(mp3Bytes(40, { tag: 'none', trailer: 'id3v1' })) ?? 0,
    v1(40),
    1e-9,
  );
  assertAlmostEquals(
    audioSeconds(mp3Bytes(40, { tag: 'none', mpeg2: true })) ?? 0,
    (40 * 576) / 22_050,
    1e-9,
  );
});

Deno.test('audioSeconds walks AAC ADTS frames', () => {
  assertAlmostEquals(audioSeconds(adtsBytes(344)) ?? 0, (344 * 1024) / 48_000, 1e-9);
});

Deno.test('audioSeconds is undefined when no duration can be read exactly', () => {
  assertEquals(audioSeconds(new Uint8Array()), undefined);
  assertEquals(audioSeconds(pngBytes(1, 1)), undefined);
  assertEquals(audioSeconds(webpBytes('VP8X', 10, 10)), undefined);
  assertEquals(audioSeconds(wavBytes(1).subarray(0, 36)), undefined);
  assertEquals(audioSeconds(mp3Bytes(40, { tag: 'none', trailer: 'garbage' })), undefined);
  assertEquals(audioSeconds(adtsBytes(10).subarray(0, 150)), undefined);
  assertEquals(audioSeconds(flacBytes(0, 44_100)), undefined);
  assertEquals(
    audioSeconds(
      mp3Bytes(1, { tag: 'xing', lame: { encoder: 'LAME3.100', delay: 1000, padding: 1000 } }),
    ),
    undefined,
  );
  assertEquals(audioSeconds(oggBytes('opus', 1, 48_000).subarray(0, 60)), undefined);
});

Deno.test('videoInfo reads the MP4 video track header, frame size, and decoded audio', () => {
  const video = { frames: 240, delta: 512, width: 1920, height: 1080 };
  assertEquals(
    videoInfo(mp4Bytes({ video, audio: { frames: 131, priming: 1024, lastShort: 820 } })),
    {
      seconds: 10,
      width: 1920,
      height: 1080,
      audioSeconds: (130 * 1024) / 48_000,
    },
  );
  // tkhd states what is presented; a reorder-delay edit does not shorten it.
  assertEquals(
    videoInfo(mp4Bytes({ video: { ...video, seconds: 2.49 }, version: 1 }))?.seconds,
    2.49,
  );
  assertEquals(videoInfo(mp4Bytes({ video }))?.audioSeconds, 0);
});

Deno.test('videoInfo is undefined without a readable video track', () => {
  assertEquals(videoInfo(mp4Bytes({ audio: { frames: 100 } })), undefined);
  assertEquals(
    videoInfo(webmBytes(50, { video: { frames: 10, frameMs: 100, width: 0, height: 360 } })),
    undefined,
  );
  assertEquals(videoInfo(pngBytes(10, 10)), undefined);
  assertEquals(videoInfo(new Uint8Array()), undefined);
});

Deno.test('videoInfo ends WebM video one frame after its latest block', () => {
  const video = { frames: 50, frameMs: 40, width: 1280, height: 720 };
  assertEquals(videoInfo(webmBytes(100, { video })), {
    seconds: 2,
    width: 1280,
    height: 720,
    audioSeconds: 2,
  });
  assertEquals(
    videoInfo(webmBytes(0, { video: { ...video, defaultDuration: true, frames: 1 } }))?.seconds,
    0.04,
  );
  assertEquals(videoInfo(webmBytes(0, { video: { ...video, reorder: true } }))?.seconds, 2);
  assertEquals(videoInfo(webmBytes(0, { video }))?.audioSeconds, 0);
  assertEquals(
    videoInfo(webmBytes(101, { video, codecDelayNs: 6_500_000, discardNs: 13_500_000 }))
      ?.audioSeconds,
    2,
  );
});

Deno.test('videoInfo falls back to WebM Duration, and leaves laced audio unknown', () => {
  const video = { frames: 50, frameMs: 40, width: 1280, height: 720 };
  const bytes = webmBytes(100, { video, duration: 2.5 });
  assertEquals(videoInfo(bytes.subarray(0, bytes.length - 3))?.seconds, 2.5);
  assertEquals(
    videoInfo(webmBytes(0, { video: { ...video, frames: 1 }, duration: 3 }))?.seconds,
    3,
  );
  assertEquals(videoInfo(webmBytes(100, { video, laced: true }))?.audioSeconds, undefined);
});

Deno.test('pdfPageCount reads flat and nested page trees', async () => {
  assertEquals(await pdfPageCount(await pdfBytes(1)), 1);
  assertEquals(await pdfPageCount(await pdfBytes(3)), 3);
  assertEquals(await pdfPageCount(await pdfBytes(7, { layout: 'nested' })), 7);
});

Deno.test('pdfPageCount reads a page tree inside a compressed object stream', async () => {
  const bytes = await pdfBytes(12, { layout: 'objectStream' });
  assertEquals(new TextDecoder('latin1').decode(bytes).includes('/Count'), false);
  assertEquals(await pdfPageCount(bytes), 12);
  assertEquals(
    await pdfPageCount(await pdfBytes(4, { layout: 'objectStream', indirectLength: true })),
    4,
  );
});

Deno.test('pdfPageCount takes the page tree from the latest incremental update', async () => {
  assertEquals(await pdfPageCount(await pdfBytes(5, { updatedTo: 2 })), 2);
  assertEquals(await pdfPageCount(await pdfBytes(2, { updatedTo: 9 })), 9);
  assertEquals(await pdfPageCount(await pdfBytes(4, { layout: 'objectStream', updatedTo: 6 })), 6);
});

Deno.test('pdfPageCount is undefined when no page tree can be read', async () => {
  assertEquals(await pdfPageCount(new Uint8Array()), undefined);
  assertEquals(await pdfPageCount(pngBytes(10, 10)), undefined);
  assertEquals(await pdfPageCount(new TextEncoder().encode('%PDF-1.7\n%%EOF\n')), undefined);
  const damaged = await pdfBytes(3, { layout: 'objectStream' });
  const text = new TextDecoder('latin1').decode(damaged);
  const body = text.indexOf('stream\n') + 'stream\n'.length;
  damaged.fill(0, body, body + 8);
  assertEquals(await pdfPageCount(damaged), undefined);
});
