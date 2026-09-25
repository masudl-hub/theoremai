/**
 * Tracks of a Matroska / WebM file: each track's type, codec, pixel size, and
 * what its blocks add up to. Shared by the audio and video readers.
 *
 * Live-recorded files (MediaRecorder, streaming muxers) leave the Segment and
 * Cluster sizes unknown and state no `Duration`; their elements are walked
 * all the same, so block timing is still read.
 *
 * @module
 */

import { ascii, view } from './bytes.ts';
import { OPUS_RATE, opusPacketSamples } from './opus.ts';

const EBML_HEADER = 0x1a45dfa3;
const MKV_SEGMENT = 0x18538067;
const MKV_INFO = 0x1549a966;
const MKV_TIMECODE_SCALE = 0x2ad7b1;
const MKV_DURATION = 0x4489;
const MKV_TRACKS = 0x1654ae6b;
const MKV_TRACK_ENTRY = 0xae;
const MKV_TRACK_NUMBER = 0xd7;
const MKV_TRACK_TYPE = 0x83;
const MKV_CODEC_ID = 0x86;
const MKV_CODEC_DELAY = 0x56aa;
const MKV_DEFAULT_DURATION = 0x23e383;
const MKV_VIDEO = 0xe0;
const MKV_PIXEL_WIDTH = 0xb0;
const MKV_PIXEL_HEIGHT = 0xba;
const MKV_CLUSTER = 0x1f43b675;
const MKV_CLUSTER_TIMECODE = 0xe7;
const MKV_SIMPLE_BLOCK = 0xa3;
const MKV_BLOCK_GROUP = 0xa0;
const MKV_BLOCK = 0xa1;
const MKV_DISCARD_PADDING = 0x75a2;
const MKV_DEFAULT_TIMECODE_SCALE = 1_000_000;
const MKV_LACING = 0x06;
/** Track number (vint), relative timestamp (int16), and flags open every block. */
const MKV_BLOCK_FIXED = 3;
const NS_PER_SECOND = 1e9;
/** Masters walked into; every other element is skipped by its size. */
const MKV_DESCEND = new Set([
  MKV_SEGMENT,
  MKV_INFO,
  MKV_TRACKS,
  MKV_TRACK_ENTRY,
  MKV_VIDEO,
  MKV_CLUSTER,
]);

/** Matroska `TrackType` values. */
export const MKV_VIDEO_TRACK = 1;
export const MKV_AUDIO_TRACK = 2;

/** One track and the sum of its blocks. */
export interface MatroskaTrack {
  number?: number;
  type?: number;
  codec?: string;
  codecDelayNs: number;
  defaultDurationNs?: number;
  pixelWidth?: number;
  pixelHeight?: number;
  /**
   * Decoded 48 kHz Opus samples — packet samples less each group's
   * `DiscardPadding`, before `CodecDelay`. `undefined` for a track that is not
   * Opus or has a block that cannot be read exactly (laced).
   */
  opusSamples?: number;
  /** Latest block timestamp, and the latest before it (ns). */
  lastNs?: number;
  previousNs?: number;
}

/** Every track, the segment's stated duration, and whether every block was walked. */
export interface Matroska {
  tracks: MatroskaTrack[];
  /** `Duration` from the segment info, in seconds. */
  durationSeconds?: number;
  /** Every element was walked to the end of the file; block sums are whole. */
  complete: boolean;
}

interface EbmlElement {
  id: number;
  /** First payload byte. */
  body: number;
  size: number;
  /** Size is the reserved "unknown" value. */
  unknown: boolean;
}

/** Variable-length integer: `value` with the length marker removed, `unknown` when all ones. */
function vint(
  bytes: Uint8Array,
  at: number,
  keepMarker: boolean,
): { value: number; length: number; unknown: boolean } | undefined {
  const first = bytes[at];
  if (first === undefined || first === 0) return undefined;
  const length = Math.clz32(first) - 23;
  if (at + length > bytes.length) return undefined;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i];
    allOnes &&= bytes[at + i] === 0xff;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function ebmlElement(bytes: Uint8Array, at: number): EbmlElement | undefined {
  const id = vint(bytes, at, true);
  if (!id) return undefined;
  const size = vint(bytes, at + id.length, false);
  if (!size) return undefined;
  return {
    id: id.value,
    body: at + id.length + size.length,
    size: size.value,
    unknown: size.unknown,
  };
}

function mkvUint(bytes: Uint8Array, at: number, size: number): number {
  let n = 0;
  for (let i = 0; i < size; i++) n = n * 256 + bytes[at + i];
  return n;
}

function mkvInt(bytes: Uint8Array, at: number, size: number): number {
  const n = mkvUint(bytes, at, size);
  return size > 0 && bytes[at] & 0x80 ? n - 2 ** (8 * size) : n;
}

/** Nanoseconds as a whole count of 48 kHz Opus samples. */
export function opusSamplesFromNs(ns: number): number {
  return Math.round((ns * OPUS_RATE) / NS_PER_SECOND);
}

/** Walk state shared by the element loop and block readers. */
interface Walk {
  tracks: MatroskaTrack[];
  scale: number;
  duration?: number;
  clusterTimecode: number;
}

/**
 * Tracks of a Matroska / WebM file, or `undefined` when the bytes do not open
 * with an EBML header. A walk that meets a truncated or unknown-sized leaf
 * element, or a block whose header cannot be read, stops there and reports
 * `complete: false`.
 */
export function matroska(bytes: Uint8Array): Matroska | undefined {
  const head = vint(bytes, 0, true);
  if (head?.value !== EBML_HEADER) return undefined;
  const walk: Walk = { tracks: [], scale: MKV_DEFAULT_TIMECODE_SCALE, clusterTimecode: 0 };
  let at = 0;
  while (at < bytes.length) {
    const el = ebmlElement(bytes, at);
    if (!el) return undefined;
    if (MKV_DESCEND.has(el.id)) {
      if (el.id === MKV_TRACK_ENTRY) walk.tracks.push({ codecDelayNs: 0, opusSamples: 0 });
      at = el.body;
      continue;
    }
    const incomplete = el.unknown || el.body + el.size > bytes.length;
    if (incomplete || !readLeaf(bytes, el, walk)) {
      // Past here nothing can be walked; only a stated duration still holds.
      return {
        tracks: walk.tracks,
        durationSeconds: seconds(walk.duration, walk.scale),
        complete: false,
      };
    }
    at = el.body + el.size;
  }
  return {
    tracks: walk.tracks,
    durationSeconds: seconds(walk.duration, walk.scale),
    complete: true,
  };
}

/** Record one leaf element; `false` when a block in it cannot be read. */
function readLeaf(bytes: Uint8Array, el: EbmlElement, walk: Walk): boolean {
  const track = walk.tracks.at(-1);
  const v = view(bytes);
  switch (el.id) {
    case MKV_TIMECODE_SCALE:
      walk.scale = mkvUint(bytes, el.body, el.size);
      break;
    case MKV_DURATION:
      walk.duration =
        el.size === 4 ? v.getFloat32(el.body) : el.size === 8 ? v.getFloat64(el.body) : undefined;
      break;
    case MKV_TRACK_NUMBER:
      if (track) track.number = mkvUint(bytes, el.body, el.size);
      break;
    case MKV_TRACK_TYPE:
      if (track) track.type = mkvUint(bytes, el.body, el.size);
      break;
    case MKV_CODEC_ID:
      if (track) track.codec = ascii(bytes, el.body, el.size).replace(/\0+$/, '');
      break;
    case MKV_CODEC_DELAY:
      if (track) track.codecDelayNs = mkvUint(bytes, el.body, el.size);
      break;
    case MKV_DEFAULT_DURATION:
      if (track) track.defaultDurationNs = mkvUint(bytes, el.body, el.size);
      break;
    case MKV_PIXEL_WIDTH:
      if (track) track.pixelWidth = mkvUint(bytes, el.body, el.size);
      break;
    case MKV_PIXEL_HEIGHT:
      if (track) track.pixelHeight = mkvUint(bytes, el.body, el.size);
      break;
    case MKV_CLUSTER_TIMECODE:
      walk.clusterTimecode = mkvUint(bytes, el.body, el.size);
      break;
    case MKV_SIMPLE_BLOCK:
      return addBlock(bytes, el.body, el.body + el.size, walk, 0);
    case MKV_BLOCK_GROUP:
      return addBlockGroup(bytes, el, walk);
  }
  return true;
}

function seconds(duration: number | undefined, scale: number): number | undefined {
  return duration === undefined ? undefined : (duration * scale) / NS_PER_SECOND;
}

/** One `BlockGroup`: its `Block`, less any `DiscardPadding` declared beside it. */
function addBlockGroup(bytes: Uint8Array, group: EbmlElement, walk: Walk): boolean {
  const end = group.body + group.size;
  let block: EbmlElement | undefined;
  let discardNs = 0;
  for (let at = group.body; at < end; ) {
    const el = ebmlElement(bytes, at);
    if (!el || el.unknown || el.body + el.size > end) return false;
    if (el.id === MKV_BLOCK) block = el;
    if (el.id === MKV_DISCARD_PADDING) discardNs = mkvInt(bytes, el.body, el.size);
    at = el.body + el.size;
  }
  return (
    block !== undefined && addBlock(bytes, block.body, block.body + block.size, walk, discardNs)
  );
}

/**
 * Credit one block to its track: its timestamp, and — for an Opus track — its
 * decoded samples. `false` when the block header itself cannot be read.
 */
function addBlock(
  bytes: Uint8Array,
  at: number,
  end: number,
  walk: Walk,
  discardNs: number,
): boolean {
  const trackNumber = vint(bytes, at, false);
  if (!trackNumber) return false;
  const header = at + trackNumber.length;
  if (header + MKV_BLOCK_FIXED > end) return false;
  const track = walk.tracks.find((t) => t.number === trackNumber.value);
  if (!track) return true;
  const relative = view(bytes).getInt16(header);
  const ns = (walk.clusterTimecode + relative) * walk.scale;
  if (track.lastNs === undefined || ns > track.lastNs) {
    track.previousNs = track.lastNs;
    track.lastNs = ns;
  } else if (ns < track.lastNs && (track.previousNs === undefined || ns > track.previousNs)) {
    track.previousNs = ns;
  }
  if (track.opusSamples === undefined) return true;
  const samples =
    track.codec === 'A_OPUS' && !(bytes[header + 2] & MKV_LACING)
      ? opusPacketSamples(bytes, header + MKV_BLOCK_FIXED, end)
      : undefined;
  track.opusSamples =
    samples === undefined ? undefined : track.opusSamples + samples - opusSamplesFromNs(discardNs);
  return true;
}
