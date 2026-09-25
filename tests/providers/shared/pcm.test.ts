import { assertEquals } from '../../../src/kernel/engine/assert.ts';
import {
  pcmFormatFromMime,
  pcmMediaAsWav,
  wrapPcmAsWav,
  writeAscii,
} from '../../../src/providers/shared/pcm.ts';

const MONO_24K = { sampleRate: 24000, channels: 1 };

function ascii(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

Deno.test('writeAscii writes each character code at the given offset', () => {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  writeAscii(view, 2, 'AB');
  assertEquals(view.getUint8(2), 'A'.charCodeAt(0));
  assertEquals(view.getUint8(3), 'B'.charCodeAt(0));
});

Deno.test('writeAscii writes nothing for an empty string', () => {
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);
  writeAscii(view, 0, '');
  assertEquals(view.getUint8(0), 0);
});

Deno.test('wrapPcmAsWav writes a 44-byte RIFF/WAVE PCM header', () => {
  const pcm = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  const wav = wrapPcmAsWav(pcm, MONO_24K);
  assertEquals(wav.length, 44 + pcm.length);
  const view = new DataView(wav.buffer);
  assertEquals(ascii(view, 0), 'RIFF');
  assertEquals(ascii(view, 8), 'WAVE');
  assertEquals(ascii(view, 12), 'fmt ');
  assertEquals(view.getUint16(20, true), 1);
  assertEquals(view.getUint16(22, true), 1);
  assertEquals(view.getUint32(24, true), 24000);
  assertEquals(view.getUint16(34, true), 16);
  assertEquals(ascii(view, 36), 'data');
  assertEquals(view.getUint32(40, true), pcm.length);
});

Deno.test('wrapPcmAsWav computes byte rate and block align from rate and channels', () => {
  const wav = wrapPcmAsWav(new Uint8Array([1, 2, 3, 4]), { sampleRate: 16000, channels: 2 });
  const view = new DataView(wav.buffer);
  assertEquals(view.getUint16(22, true), 2);
  assertEquals(view.getUint32(24, true), 16000);
  assertEquals(view.getUint32(28, true), 16000 * 4);
  assertEquals(view.getUint16(32, true), 4);
});

Deno.test('wrapPcmAsWav handles empty PCM input', () => {
  const wav = wrapPcmAsWav(new Uint8Array([]), MONO_24K);
  assertEquals(wav.length, 44);
  const view = new DataView(wav.buffer);
  assertEquals(view.getUint32(4, true), 36);
  assertEquals(view.getUint32(40, true), 0);
});

Deno.test('wrapPcmAsWav copies PCM bytes verbatim into the data chunk', () => {
  const pcm = new Uint8Array([9, 8, 7, 6, 5]);
  const wav = wrapPcmAsWav(pcm, MONO_24K);
  assertEquals(wav.slice(44), pcm);
});

Deno.test('wrapPcmAsWav sets the RIFF chunk size to 36 plus data length', () => {
  const pcm = new Uint8Array(10);
  const wav = wrapPcmAsWav(pcm, MONO_24K);
  const view = new DataView(wav.buffer);
  assertEquals(view.getUint32(4, true), 36 + pcm.length);
});

Deno.test('pcmFormatFromMime reads the format each transport states', () => {
  assertEquals(pcmFormatFromMime('audio/pcm;rate=24000'), MONO_24K);
  assertEquals(pcmFormatFromMime('audio/l16; rate=24000; channels=1'), MONO_24K);
  assertEquals(pcmFormatFromMime('audio/pcm;rate=24000;channels=1'), MONO_24K);
  assertEquals(pcmFormatFromMime('Audio/L16; Rate=16000; Channels=2'), {
    sampleRate: 16000,
    channels: 2,
  });
});

Deno.test('pcmFormatFromMime is undefined without a rate or for other audio', () => {
  assertEquals(pcmFormatFromMime('audio/pcm'), undefined);
  assertEquals(pcmFormatFromMime('audio/l16'), undefined);
  assertEquals(pcmFormatFromMime('audio/pcm;rate=abc'), undefined);
  assertEquals(pcmFormatFromMime('audio/pcm;rate=24000;channels=0'), undefined);
  assertEquals(pcmFormatFromMime('audio/wav'), undefined);
  assertEquals(pcmFormatFromMime('audio/mpeg;rate=24000'), undefined);
});

Deno.test('pcmMediaAsWav wraps stated pcm and keeps everything else', () => {
  const data = btoa(String.fromCharCode(1, 2, 3, 4));
  const wav = pcmMediaAsWav({ mimeType: 'audio/pcm;rate=24000', data });
  assertEquals(wav.mimeType, 'audio/wav');
  assertEquals(atob(wav.data).length, 48);
  assertEquals(pcmMediaAsWav({ mimeType: 'audio/l16', data }), {
    mimeType: 'audio/l16',
    data,
  });
  assertEquals(pcmMediaAsWav({ mimeType: 'image/jpeg', data }), { mimeType: 'image/jpeg', data });
});
