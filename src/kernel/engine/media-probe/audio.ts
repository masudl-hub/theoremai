/**
 * Decoded audio duration from container and frame headers — WAV, AIFF, FLAC,
 * Ogg (Opus, Vorbis, FLAC), Matroska / WebM, MP4 / M4A, MP3, and AAC ADTS.
 * Samples are never decoded; where a container does not state its duration,
 * frame headers are walked and their sample counts summed. Decoded means what
 * a decoder outputs: encoder delay and padding the stream declares are dropped
 * (Opus pre-skip, `CodecDelay` and `DiscardPadding`; LAME delay and padding; the
 * MP4 edit list's leading skip). An MP4 edit that ends inside the last sample
 * keeps that whole sample, as decoders do; ADTS declares no delay, so its
 * priming samples count.
 *
 * @module
 */

import { ascii, id3v2End, uint64, view } from './bytes.ts';
import { MKV_AUDIO_TRACK, matroska, opusSamplesFromNs } from './matroska.ts';
import { MP4_SOUND, mp4Tracks } from './mp4.ts';
import { OPUS_RATE } from './opus.ts';

const RIFF_HEADER = 12;
const CHUNK_HEADER = 8;
const WAV_BYTE_RATE_OFFSET = 8;

function positiveSeconds(seconds: number): number | undefined {
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

// ── WAV ───────────────────────────────────────────────────────────────────

function wavSeconds(bytes: Uint8Array): number | undefined {
  if (
    bytes.length < RIFF_HEADER ||
    ascii(bytes, 0, 4) !== 'RIFF' ||
    ascii(bytes, 8, 4) !== 'WAVE'
  ) {
    return undefined;
  }
  const v = view(bytes);
  let byteRate: number | undefined;
  let at = RIFF_HEADER;
  while (at + CHUNK_HEADER <= bytes.length) {
    const id = ascii(bytes, at, 4);
    const size = v.getUint32(at + 4, true);
    if (id === 'fmt ' && at + CHUNK_HEADER + WAV_BYTE_RATE_OFFSET + 4 <= bytes.length) {
      byteRate = v.getUint32(at + CHUNK_HEADER + WAV_BYTE_RATE_OFFSET, true);
    }
    if (id === 'data') {
      return byteRate ? positiveSeconds(size / byteRate) : undefined;
    }
    at += CHUNK_HEADER + size + (size % 2);
  }
  return undefined;
}

// ── AIFF / AIFF-C ─────────────────────────────────────────────────────────

const AIFF_COMM_FRAMES = 2;
const AIFF_COMM_RATE = 8;
const AIFF_COMM_MIN = 18;
const EXTENDED_BIAS = 16383;
const EXTENDED_MANTISSA_BITS = 63;

/** IEEE 754 80-bit extended float (AIFF sample rate). */
function extended80(v: DataView, at: number): number {
  const exponent = v.getUint16(at) & 0x7fff;
  const mantissa = v.getUint32(at + 2) * 2 ** 32 + v.getUint32(at + 6);
  return mantissa * 2 ** (exponent - EXTENDED_BIAS - EXTENDED_MANTISSA_BITS);
}

function aiffSeconds(bytes: Uint8Array): number | undefined {
  if (bytes.length < RIFF_HEADER || ascii(bytes, 0, 4) !== 'FORM') return undefined;
  const form = ascii(bytes, 8, 4);
  if (form !== 'AIFF' && form !== 'AIFC') return undefined;
  const v = view(bytes);
  let at = RIFF_HEADER;
  while (at + CHUNK_HEADER <= bytes.length) {
    const size = v.getUint32(at + 4);
    if (ascii(bytes, at, 4) === 'COMM') {
      if (size < AIFF_COMM_MIN || at + CHUNK_HEADER + AIFF_COMM_MIN > bytes.length) {
        return undefined;
      }
      const body = at + CHUNK_HEADER;
      const frames = v.getUint32(body + AIFF_COMM_FRAMES);
      return positiveSeconds(frames / extended80(v, body + AIFF_COMM_RATE));
    }
    at += CHUNK_HEADER + size + (size % 2);
  }
  return undefined;
}

// ── FLAC ──────────────────────────────────────────────────────────────────

const FLAC_BLOCK_HEADER = 4;
const FLAC_STREAMINFO = 0;
const FLAC_STREAMINFO_LENGTH = 34;
const FLAC_BLOCK_TYPE_MASK = 0x7f;

/** Sample rate from a FLAC STREAMINFO body (20 bits at byte 10). */
function streamInfoRate(bytes: Uint8Array, at: number): number | undefined {
  if (at + FLAC_STREAMINFO_LENGTH > bytes.length) return undefined;
  return (bytes[at + 10] << 12) | (bytes[at + 11] << 4) | (bytes[at + 12] >> 4);
}

/** Seconds from a FLAC STREAMINFO body: sample rate and 36-bit total samples. */
function streamInfoSeconds(bytes: Uint8Array, at: number): number | undefined {
  const rate = streamInfoRate(bytes, at);
  if (rate === undefined) return undefined;
  const samples = (bytes[at + 13] & 0x0f) * 2 ** 32 + view(bytes).getUint32(at + 14);
  return positiveSeconds(samples / rate);
}

function flacSeconds(bytes: Uint8Array): number | undefined {
  const at = id3v2End(bytes);
  if (at + 4 + FLAC_BLOCK_HEADER > bytes.length || ascii(bytes, at, 4) !== 'fLaC') {
    return undefined;
  }
  const header = at + 4;
  if ((bytes[header] & FLAC_BLOCK_TYPE_MASK) !== FLAC_STREAMINFO) return undefined;
  return streamInfoSeconds(bytes, header + FLAC_BLOCK_HEADER);
}

// ── Ogg (Opus, Vorbis, FLAC) ──────────────────────────────────────────────

const OGG_PAGE_HEADER = 27;
const OGG_GRANULE = 6;
const OGG_SERIAL = 14;
const OGG_SEGMENTS = 26;
const OPUS_PRE_SKIP = 10;
const VORBIS_RATE = 12;
/** Ogg FLAC mapping header (9 bytes) precedes `fLaC` and the STREAMINFO block header. */
const OGG_FLAC_STREAMINFO = 9 + 4 + FLAC_BLOCK_HEADER;

interface OggPage {
  granule: number | undefined;
  serial: number;
  payload: number;
}

function oggPage(bytes: Uint8Array, at: number): OggPage | undefined {
  if (
    at + OGG_PAGE_HEADER > bytes.length ||
    ascii(bytes, at, 4) !== 'OggS' ||
    bytes[at + 4] !== 0
  ) {
    return undefined;
  }
  const v = view(bytes);
  const noGranule =
    v.getUint32(at + OGG_GRANULE, true) === 0xffffffff &&
    v.getUint32(at + OGG_GRANULE + 4, true) === 0xffffffff;
  return {
    granule: noGranule ? undefined : uint64(v, at + OGG_GRANULE, true),
    serial: v.getUint32(at + OGG_SERIAL, true),
    payload: at + OGG_PAGE_HEADER + bytes[at + OGG_SEGMENTS],
  };
}

/** Granule position of the last page of `serial` that completes a packet. */
function lastGranule(bytes: Uint8Array, serial: number): number | undefined {
  for (let at = bytes.length - OGG_PAGE_HEADER; at >= 0; at--) {
    if (bytes[at] !== 0x4f) continue;
    const page = oggPage(bytes, at);
    if (page && page.serial === serial && page.granule !== undefined) return page.granule;
  }
  return undefined;
}

function oggSeconds(bytes: Uint8Array): number | undefined {
  const first = oggPage(bytes, 0);
  if (!first) return undefined;
  const at = first.payload;
  const v = view(bytes);
  const has = (n: number) => at + n <= bytes.length;
  let rate: number | undefined;
  let preSkip = 0;
  if (has(OPUS_PRE_SKIP + 2) && ascii(bytes, at, 8) === 'OpusHead') {
    rate = OPUS_RATE;
    preSkip = v.getUint16(at + OPUS_PRE_SKIP, true);
  } else if (has(VORBIS_RATE + 4) && bytes[at] === 1 && ascii(bytes, at + 1, 6) === 'vorbis') {
    rate = v.getUint32(at + VORBIS_RATE, true);
  } else if (bytes[at] === 0x7f && has(5) && ascii(bytes, at + 1, 4) === 'FLAC') {
    rate = streamInfoRate(bytes, at + OGG_FLAC_STREAMINFO);
  } else {
    return undefined;
  }
  const granule = lastGranule(bytes, first.serial);
  if (granule === undefined || !rate) return undefined;
  return positiveSeconds((granule - preSkip) / rate);
}

// ── Matroska / WebM ───────────────────────────────────────────────────────

/**
 * Decoded length of a Matroska / WebM file's audio. Unlaced Opus blocks are
 * summed as a decoder outputs them — packet samples less the track's
 * `CodecDelay` and each group's `DiscardPadding`. Otherwise the segment's
 * stated `Duration` is used; without one the length is unknown.
 */
function matroskaSeconds(bytes: Uint8Array): number | undefined {
  const file = matroska(bytes);
  if (!file) return undefined;
  const audio = file.tracks.filter((t) => t.type === MKV_AUDIO_TRACK);
  const decoded = audio.map((t) =>
    t.opusSamples === undefined ? undefined : t.opusSamples - opusSamplesFromNs(t.codecDelayNs),
  );
  if (file.complete && audio.length > 0 && decoded.every((n) => n !== undefined)) {
    const samples = Math.max(...decoded);
    if (samples > 0) return positiveSeconds(samples / OPUS_RATE);
  }
  return file.durationSeconds === undefined ? undefined : positiveSeconds(file.durationSeconds);
}

// ── MP4 / M4A ─────────────────────────────────────────────────────────────

/** Decoded length of the first sound track. */
function mp4Seconds(bytes: Uint8Array): number | undefined {
  return mp4Tracks(bytes)?.find((t) => t.handler === MP4_SOUND)?.decodedSeconds;
}

// ── MP3 and AAC ADTS ──────────────────────────────────────────────────────

const MPEG_VERSION_1 = 3;
const MPEG_VERSION_2 = 2;
const MPEG_VERSION_25 = 0;
const MPEG_LAYER_1 = 3;
const MPEG_LAYER_2 = 2;
const MPEG_LAYER_3 = 1;
const MPEG_MONO = 3;
const MPEG_RATES: Record<number, number[]> = {
  [MPEG_VERSION_1]: [44_100, 48_000, 32_000],
  [MPEG_VERSION_2]: [22_050, 24_000, 16_000],
  [MPEG_VERSION_25]: [11_025, 12_000, 8_000],
};
/** kbit/s by [version 1?][layer][index]. */
const MPEG_BITRATES: Record<'v1' | 'v2', Record<number, number[]>> = {
  v1: {
    [MPEG_LAYER_1]: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [MPEG_LAYER_2]: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [MPEG_LAYER_3]: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  },
  v2: {
    [MPEG_LAYER_1]: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [MPEG_LAYER_2]: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [MPEG_LAYER_3]: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
};
const MPEG_HEADER = 4;
const LAYER_1_SLOT = 4;
const XING_FRAMES_FLAG = 0x01;
/** Optional Xing fields in order — frames, bytes, TOC, quality — as [flag, width]. */
const XING_FIELDS = [
  [0x01, 4],
  [0x02, 4],
  [0x04, 100],
  [0x08, 4],
] as const;
/** Encoder strings whose info tag carries encoder delay and padding (LAME and ffmpeg). */
const LAME_ENCODERS = ['LAME', 'Lavf', 'Lavc'];
/** 12-bit encoder delay and padding follow the 9-byte version, revision, lowpass, and gain fields. */
const LAME_DELAY_PADDING = 21;
const VBRI_OFFSET = 36;
const VBRI_FRAMES = 14;
/** Side-information length by [version 1?][mono?] — the Xing tag follows it. */
const MPEG_SIDE_INFO = { v1: { mono: 17, stereo: 32 }, v2: { mono: 9, stereo: 17 } } as const;
const ADTS_RATES = [
  96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000,
  7_350,
];
const ADTS_HEADER = 7;
const AAC_FRAME_SAMPLES = 1024;
/** Trailing tags that may follow the last frame. */
const TRAILING_TAGS = ['TAG', 'APETAGEX', 'LYRICSBEGIN'];

interface MpegFrame {
  length: number;
  samples: number;
  rate: number;
  sideInfo: number;
}

function mpegFrame(bytes: Uint8Array, at: number): MpegFrame | undefined {
  if (at + MPEG_HEADER > bytes.length || bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) {
    return undefined;
  }
  const version = (bytes[at + 1] >> 3) & 0x03;
  const layer = (bytes[at + 1] >> 1) & 0x03;
  const bitrateIndex = bytes[at + 2] >> 4;
  const rateIndex = (bytes[at + 2] >> 2) & 0x03;
  const padding = (bytes[at + 2] >> 1) & 0x01;
  const mono = bytes[at + 3] >> 6 === MPEG_MONO;
  const rate = MPEG_RATES[version]?.[rateIndex];
  const family = version === MPEG_VERSION_1 ? 'v1' : 'v2';
  const kbps = MPEG_BITRATES[family][layer]?.[bitrateIndex];
  if (!rate || !kbps) return undefined;
  const samples =
    layer === MPEG_LAYER_1 ? 384 : layer === MPEG_LAYER_3 && family === 'v2' ? 576 : 1152;
  const length =
    layer === MPEG_LAYER_1
      ? (Math.floor((12 * kbps * 1000) / rate) + padding) * LAYER_1_SLOT
      : Math.floor(((samples / 8) * kbps * 1000) / rate) + padding;
  const sideInfo = MPEG_SIDE_INFO[family][mono ? 'mono' : 'stereo'];
  return { length, samples, rate, sideInfo };
}

/**
 * Audio frame count from a Xing / Info or VBRI tag in the first frame, and the
 * encoder delay plus padding a LAME info tag declares (samples a decoder drops).
 */
function vbrFrames(
  bytes: Uint8Array,
  at: number,
  frame: MpegFrame,
): { frames: number; trimmed: number } | undefined {
  const v = view(bytes);
  const xing = at + MPEG_HEADER + frame.sideInfo;
  const tag = xing + 8 <= bytes.length ? ascii(bytes, xing, 4) : '';
  if ((tag === 'Xing' || tag === 'Info') && v.getUint32(xing + 4) & XING_FRAMES_FLAG) {
    if (xing + 12 > bytes.length) return undefined;
    const flags = v.getUint32(xing + 4);
    let lame = xing + 8;
    for (const [flag, width] of XING_FIELDS) if (flags & flag) lame += width;
    return { frames: v.getUint32(xing + 8), trimmed: lameTrimmed(bytes, lame) };
  }
  const vbri = at + VBRI_OFFSET;
  if (vbri + VBRI_FRAMES + 4 <= bytes.length && ascii(bytes, vbri, 4) === 'VBRI') {
    return { frames: v.getUint32(vbri + VBRI_FRAMES), trimmed: 0 };
  }
  return undefined;
}

/** Encoder delay plus padding from a LAME info tag at `at`; 0 when there is none. */
function lameTrimmed(bytes: Uint8Array, at: number): number {
  const fields = at + LAME_DELAY_PADDING;
  if (fields + 3 > bytes.length || !LAME_ENCODERS.includes(ascii(bytes, at, 4))) return 0;
  const delay = (bytes[fields] << 4) | (bytes[fields + 1] >> 4);
  const padding = ((bytes[fields + 1] & 0x0f) << 8) | bytes[fields + 2];
  return delay + padding;
}

function adtsFrame(
  bytes: Uint8Array,
  at: number,
): { length: number; samples: number; rate: number } | undefined {
  if (at + ADTS_HEADER > bytes.length || bytes[at] !== 0xff || (bytes[at + 1] & 0xf6) !== 0xf0) {
    return undefined;
  }
  const rate = ADTS_RATES[(bytes[at + 2] >> 2) & 0x0f];
  const length = ((bytes[at + 3] & 0x03) << 11) | (bytes[at + 4] << 3) | (bytes[at + 5] >> 5);
  const blocks = (bytes[at + 6] & 0x03) + 1;
  if (!rate || length < ADTS_HEADER) return undefined;
  return { length, samples: blocks * AAC_FRAME_SAMPLES, rate };
}

/** True when `at` is the end of the data or the start of a trailing tag. */
function atStreamEnd(bytes: Uint8Array, at: number): boolean {
  if (at === bytes.length) return true;
  return TRAILING_TAGS.some((tag) => ascii(bytes, at, tag.length) === tag);
}

/** Walk frames from `start`; `undefined` unless every byte up to a trailing tag is a frame. */
function walkFrames(
  bytes: Uint8Array,
  start: number,
  read: (at: number) => { length: number; samples: number; rate: number } | undefined,
): number | undefined {
  let at = start;
  let seconds = 0;
  while (!atStreamEnd(bytes, at)) {
    const frame = read(at);
    if (!frame || at + frame.length > bytes.length) return undefined;
    seconds += frame.samples / frame.rate;
    at += frame.length;
  }
  return positiveSeconds(seconds);
}

function mpegAudioSeconds(bytes: Uint8Array): number | undefined {
  const start = id3v2End(bytes);
  if (adtsFrame(bytes, start)) return walkFrames(bytes, start, (at) => adtsFrame(bytes, at));
  const first = mpegFrame(bytes, start);
  if (!first) return undefined;
  const tagged = vbrFrames(bytes, start, first);
  if (tagged !== undefined) {
    const samples = tagged.frames * first.samples;
    if (tagged.trimmed >= samples) return undefined;
    return positiveSeconds((samples - tagged.trimmed) / first.rate);
  }
  return walkFrames(bytes, start, (at) => mpegFrame(bytes, at));
}

/**
 * Decoded duration in seconds of WAV, AIFF, FLAC, Ogg (Opus / Vorbis / FLAC),
 * Matroska / WebM, MP4 / M4A, MP3, or AAC ADTS audio — identified by its
 * bytes, not its declared MIME type. `undefined` for anything else, or when
 * the duration cannot be read exactly (a WebM without a duration whose blocks
 * are not unlaced Opus; an MP3 or ADTS stream with bytes that are not frames;
 * a LAME tag that trims more samples than the stream holds).
 */
export function audioSeconds(bytes: Uint8Array): number | undefined {
  return (
    wavSeconds(bytes) ??
    aiffSeconds(bytes) ??
    flacSeconds(bytes) ??
    oggSeconds(bytes) ??
    matroskaSeconds(bytes) ??
    mp4Seconds(bytes) ??
    mpegAudioSeconds(bytes)
  );
}
