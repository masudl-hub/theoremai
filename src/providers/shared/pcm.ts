/**
 * Raw PCM → WAV, shared by every transport that returns raw audio.
 *
 * Each transport states the format on the wire (probes 23/09/2026):
 * - Gemini Live: `audio/pcm;rate=24000`
 * - Interactions: `audio/l16; rate=24000; channels=1` (buffered), or
 *   `audio/l16` with `sample_rate` / `channels` fields (stream deltas)
 * - OpenRouter speech: `content-type: audio/pcm;rate=24000;channels=1`
 *
 * Samples are 16-bit little-endian on all three (measured), although RFC 2586
 * defines `audio/L16` as big-endian. A mime without `rate=` has no known
 * format, so its bytes pass through unchanged rather than being wrapped at a
 * guessed rate. `channels=` absent means one channel (the RFC 2586 default;
 * Live documents mono output).
 *
 * @module
 */

import { base64ToBytes, bytesToBase64 } from '../../kernel/util/base64.ts';

const BITS_PER_SAMPLE = 16;
const RAW_PCM_ESSENCES = new Set(['audio/pcm', 'audio/l16']);

export interface PcmFormat {
  sampleRate: number;
  channels: number;
}

export function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n > 0 ? n : undefined;
}

/** Split a mime into its lower-cased essence and parameters. */
function parseMime(mime: string): { essence: string; params: Map<string, string> } {
  const [essence = '', ...rest] = mime.split(';');
  const params = new Map<string, string>();
  for (const param of rest) {
    const eq = param.indexOf('=');
    if (eq > 0) params.set(param.slice(0, eq).trim().toLowerCase(), param.slice(eq + 1).trim());
  }
  return { essence: essence.trim().toLowerCase(), params };
}

/** The PCM format a raw PCM mime states; undefined when it is not raw PCM or has no rate. */
export function pcmFormatFromMime(mime: string): PcmFormat | undefined {
  const { essence, params } = parseMime(mime);
  if (!RAW_PCM_ESSENCES.has(essence)) return undefined;
  const sampleRate = positiveInt(params.get('rate'));
  if (sampleRate === undefined) return undefined;
  const channels = params.has('channels') ? positiveInt(params.get('channels')) : 1;
  if (channels === undefined) return undefined;
  return { sampleRate, channels };
}

/** Wrap raw little-endian 16-bit PCM bytes in a RIFF/WAVE container. */
export function wrapPcmAsWav(pcm: Uint8Array, format: PcmFormat): Uint8Array {
  const { sampleRate, channels } = format;
  const blockAlign = (channels * BITS_PER_SAMPLE) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  new Uint8Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

/** Base64 media as WAV when its mime states a PCM format; otherwise unchanged. */
export function pcmMediaAsWav(media: { mimeType: string; data: string }): {
  mimeType: string;
  data: string;
} {
  const format = pcmFormatFromMime(media.mimeType);
  if (!format) return media;
  const wav = wrapPcmAsWav(base64ToBytes(media.data), format);
  return { mimeType: 'audio/wav', data: bytesToBase64(wav) };
}
