import { assertEquals } from '../../../src/kernel/engine/assert.ts';
import { wrapPcmAsWav, writeAscii } from '../../../src/providers/shared/pcm.ts';

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

Deno.test('wrapPcmAsWav defaults to a 24000 Hz sample rate', () => {
  const wav = wrapPcmAsWav(new Uint8Array([1, 2, 3, 4]));
  const view = new DataView(wav.buffer);
  assertEquals(view.getUint32(24, true), 24000);
});

Deno.test('wrapPcmAsWav computes byte rate and block align for the sample rate', () => {
  const sampleRate = 16000;
  const wav = wrapPcmAsWav(new Uint8Array([1, 2]), sampleRate);
  const view = new DataView(wav.buffer);
  // numChannels=1, bitsPerSample=16 -> byteRate = sampleRate * 2, blockAlign = 2
  assertEquals(view.getUint32(28, true), sampleRate * 2);
  assertEquals(view.getUint16(32, true), 2);
});

Deno.test('wrapPcmAsWav handles empty PCM input', () => {
  const wav = wrapPcmAsWav(new Uint8Array([]));
  assertEquals(wav.length, 44);
  const view = new DataView(wav.buffer);
  assertEquals(view.getUint32(4, true), 36);
  assertEquals(view.getUint32(40, true), 0);
});

Deno.test('wrapPcmAsWav copies PCM bytes verbatim into the data chunk', () => {
  const pcm = new Uint8Array([9, 8, 7, 6, 5]);
  const wav = wrapPcmAsWav(pcm);
  assertEquals(wav.slice(44), pcm);
});

Deno.test('wrapPcmAsWav sets the RIFF chunk size to 36 plus data length', () => {
  const pcm = new Uint8Array(10);
  const wav = wrapPcmAsWav(pcm);
  const view = new DataView(wav.buffer);
  assertEquals(view.getUint32(4, true), 36 + pcm.length);
});
