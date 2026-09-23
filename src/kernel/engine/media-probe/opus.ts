/**
 * Opus packet timing, shared by the Ogg and Matroska readers.
 *
 * @module
 */

/** Opus always decodes at 48 kHz. */
export const OPUS_RATE = 48_000;
const MS_PER_SECOND = 1000;
const TOC_CONFIG_SHIFT = 3;
const TOC_FRAME_CODE = 0x03;
const FRAME_COUNT_MASK = 0x3f;
const SILK_CONFIGS = 12;
const HYBRID_CONFIGS = 16;

/** Opus packet duration in 48 kHz samples from its TOC byte (RFC 6716 §3.1). */
export function opusPacketSamples(bytes: Uint8Array, at: number, end: number): number | undefined {
  if (at >= end) return undefined;
  const toc = bytes[at];
  const config = toc >> TOC_CONFIG_SHIFT;
  const frameMs =
    config < SILK_CONFIGS
      ? [10, 20, 40, 60][config % 4]
      : config < HYBRID_CONFIGS
        ? [10, 20][config % 2]
        : [2.5, 5, 10, 20][config % 4];
  const code = toc & TOC_FRAME_CODE;
  const frames =
    code === 0 ? 1 : code < 3 ? 2 : at + 1 < end ? bytes[at + 1] & FRAME_COUNT_MASK : undefined;
  return frames === undefined ? undefined : (frameMs * frames * OPUS_RATE) / MS_PER_SECOND;
}
