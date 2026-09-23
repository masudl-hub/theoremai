/**
 * Tracks of an ISO base media file (MP4, M4A, MOV, 3GP): each track's
 * handler, presented and decoded lengths, and — for video — coded pixel size.
 * Shared by the audio and video readers.
 *
 * @module
 */

import { ascii, uint64, view } from './bytes.ts';
import { type Box, boxes, FULL_BOX_HEADER } from './iso-bmff.ts';

const TIMED_V0_SCALE = 12;
const TIMED_V1_SCALE = 20;
const TKHD_V0_TRACK_ID = 12;
const TKHD_V1_TRACK_ID = 20;
const TKHD_V0_DURATION = 20;
const TKHD_V1_DURATION = 28;
const STTS_ENTRIES = FULL_BOX_HEADER + 4;
const STTS_ENTRY = 8;
const HDLR_TYPE = FULL_BOX_HEADER + 4;
/** Visual sample entry: 8-byte box header, 6 reserved, data reference, 16 pre-defined/reserved. */
const VISUAL_ENTRY_WIDTH = 8 + 6 + 2 + 16;
const STSD_ENTRIES = FULL_BOX_HEADER + 4;
const TFHD_DEFAULT_DURATION = 0x08;
const TFHD_OPTIONAL = [
  [0x01, 8],
  [0x02, 4],
] as const;
const TRUN_DATA_OFFSET = 0x01;
const TRUN_FIRST_FLAGS = 0x04;
const TRUN_DURATION = 0x100;
const TRUN_FIELDS = [0x100, 0x200, 0x400, 0x800] as const;
const U32_UNKNOWN = 0xffffffff;
/** `elst` media time of an empty edit — a gap that plays no samples. */
const EMPTY_EDIT = -1;
const ELST_ENTRIES = FULL_BOX_HEADER + 4;
const ELST_V0_ENTRY = 12;
const ELST_V1_ENTRY = 20;

/** `hdlr` handler types. */
export const MP4_SOUND = 'soun';
export const MP4_VIDEO = 'vide';
const MPEG4_AUDIO = 'mp4a';

/** One track of the movie. */
export interface Mp4Track {
  /** `hdlr` handler type — `soun`, `vide`, … */
  handler: string;
  /**
   * Presented length: the `tkhd` duration (edit-list aware), else the sum of
   * the track's sample durations. `undefined` when neither can be read.
   */
  seconds?: number;
  /**
   * Decoded length: every sample from the edit list's leading skip (encoder
   * priming, reorder delay) to the end of the sample the edit ends in — a
   * decoder drops the skip but keeps the rest of that last sample (a whole
   * frame, for MPEG-4 audio). `undefined`
   * when the samples cannot be summed, or the edit list holds more than one
   * non-empty edit or ends before the last sample.
   */
  decodedSeconds?: number;
  /** Coded frame size from the first visual sample entry (video tracks). */
  width?: number;
  height?: number;
}

/** Timescale and duration from an `mvhd` or `mdhd` payload. */
function timedHeader(
  bytes: Uint8Array,
  box: Box,
): { scale: number; duration?: number } | undefined {
  const v = view(bytes);
  const version = bytes[box.start];
  const scaleAt = box.start + (version === 1 ? TIMED_V1_SCALE : TIMED_V0_SCALE);
  if (scaleAt + (version === 1 ? 12 : 8) > box.end) return undefined;
  const scale = v.getUint32(scaleAt);
  const duration = version === 1 ? uint64(v, scaleAt + 4) : knownU32(v.getUint32(scaleAt + 4));
  return scale > 0 ? { scale, duration } : undefined;
}

function knownU32(n: number): number | undefined {
  return n === U32_UNKNOWN ? undefined : n;
}

function childList(bytes: Uint8Array, box: Box): Box[] {
  return boxes(bytes, box.start, box.end).list;
}

/** First child at `path` below `box`. */
function descend(bytes: Uint8Array, box: Box, path: string[]): Box | undefined {
  let at: Box | undefined = box;
  for (const type of path) {
    at = at ? childList(bytes, at).find((b) => b.type === type) : undefined;
  }
  return at;
}

/** Track id and presented duration (movie timescale) from `tkhd`. */
function trackHeader(bytes: Uint8Array, tkhd: Box): { id: number; duration?: number } | undefined {
  const v = view(bytes);
  const wide = bytes[tkhd.start] === 1;
  const idAt = tkhd.start + (wide ? TKHD_V1_TRACK_ID : TKHD_V0_TRACK_ID);
  const durationAt = tkhd.start + (wide ? TKHD_V1_DURATION : TKHD_V0_DURATION);
  if (durationAt + (wide ? 8 : 4) > tkhd.end) return undefined;
  const duration = wide ? uint64(v, durationAt) : knownU32(v.getUint32(durationAt));
  return { id: v.getUint32(idAt), duration };
}

/** The one non-empty edit: where it starts (media timescale) and how long it plays (movie timescale, `0` = to the end). */
interface Edit {
  mediaTime: number;
  duration: number;
}

/**
 * The track's non-empty edit — `{ mediaTime: 0, duration: 0 }` without an edit
 * list; `undefined` when the list cannot be read or holds more than one.
 */
function soleEdit(bytes: Uint8Array, elst: Box | undefined): Edit | undefined {
  if (!elst) return { mediaTime: 0, duration: 0 };
  const v = view(bytes);
  const wide = bytes[elst.start] === 1;
  const size = wide ? ELST_V1_ENTRY : ELST_V0_ENTRY;
  if (elst.start + ELST_ENTRIES > elst.end) return undefined;
  const count = v.getUint32(elst.start + FULL_BOX_HEADER);
  let edit: Edit | undefined;
  for (let i = 0, at = elst.start + ELST_ENTRIES; i < count; i++, at += size) {
    if (at + size > elst.end) return undefined;
    const duration = wide ? uint64(v, at) : v.getUint32(at);
    const mediaTime = wide ? int64(v, at + 8) : v.getInt32(at + 4);
    if (duration === undefined || mediaTime === undefined) return undefined;
    if (mediaTime === EMPTY_EDIT) continue;
    if (edit) return undefined;
    edit = { mediaTime, duration };
  }
  return edit ?? { mediaTime: 0, duration: 0 };
}

function int64(v: DataView, at: number): number | undefined {
  const n = v.getBigInt64(at);
  return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(n)
    : undefined;
}

/** Four-character type of the first sample entry in `stsd`. */
function sampleEntry(bytes: Uint8Array, stsd: Box): string | undefined {
  const at = stsd.start + STSD_ENTRIES;
  return at + 8 <= stsd.end ? ascii(bytes, at + 4, 4) : undefined;
}

/** Coded width and height from the first visual sample entry in `stsd`. */
function visualSize(bytes: Uint8Array, stsd: Box): { width: number; height: number } | undefined {
  const entry = stsd.start + STSD_ENTRIES;
  const at = entry + VISUAL_ENTRY_WIDTH;
  if (at + 4 > stsd.end) return undefined;
  const v = view(bytes);
  const width = v.getUint16(at);
  const height = v.getUint16(at + 2);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** Default sample duration for `trackId` from `moov/mvex/trex`. */
function trexDuration(bytes: Uint8Array, moov: Box, trackId: number): number | undefined {
  const mvex = descend(bytes, moov, ['mvex']);
  if (!mvex) return undefined;
  const v = view(bytes);
  for (const trex of childList(bytes, mvex).filter((b) => b.type === 'trex')) {
    const at = trex.start + FULL_BOX_HEADER;
    if (at + 12 <= trex.end && v.getUint32(at) === trackId) return v.getUint32(at + 8);
  }
  return undefined;
}

/** Total sample duration of a track, and the durations of its last two samples (media timescale). */
interface Samples {
  ticks: number;
  last: number;
  previous?: number;
}

function addSamples(sum: Samples | undefined, count: number, delta: number): Samples {
  if (count === 0) return sum ?? { ticks: 0, last: 0 };
  return {
    ticks: (sum?.ticks ?? 0) + count * delta,
    last: delta,
    previous: count > 1 ? delta : sum?.last,
  };
}

/** Sample durations from the track's `stts`. */
function sttsSamples(bytes: Uint8Array, stts: Box | undefined): Samples | undefined {
  if (!stts || stts.start + STTS_ENTRIES > stts.end) return undefined;
  const v = view(bytes);
  const count = v.getUint32(stts.start + FULL_BOX_HEADER);
  let sum: Samples | undefined;
  for (let i = 0, at = stts.start + STTS_ENTRIES; i < count; i++, at += STTS_ENTRY) {
    if (at + STTS_ENTRY > stts.end) return undefined;
    sum = addSamples(sum, v.getUint32(at), v.getUint32(at + 4));
  }
  return sum;
}

/** Sample durations for `trackId` across every movie fragment. */
function fragmentSamples(
  bytes: Uint8Array,
  top: Box[],
  trackId: number,
  trex: number | undefined,
): Samples | undefined {
  const v = view(bytes);
  let sum: Samples | undefined;
  for (const moof of top.filter((b) => b.type === 'moof')) {
    for (const traf of childList(bytes, moof).filter((b) => b.type === 'traf')) {
      const inner = childList(bytes, traf);
      const tfhd = inner.find((b) => b.type === 'tfhd');
      if (!tfhd || tfhd.start + 8 > tfhd.end) return undefined;
      const tfhdFlags = v.getUint32(tfhd.start) & 0xffffff;
      if (v.getUint32(tfhd.start + FULL_BOX_HEADER) !== trackId) continue;
      let at = tfhd.start + 8;
      for (const [flag, width] of TFHD_OPTIONAL) if (tfhdFlags & flag) at += width;
      const fallback =
        tfhdFlags & TFHD_DEFAULT_DURATION && at + 4 <= tfhd.end ? v.getUint32(at) : trex;
      for (const trun of inner.filter((b) => b.type === 'trun')) {
        const next = runSamples(v, trun, fallback, sum);
        if (next === undefined) return undefined;
        sum = next;
      }
    }
  }
  return sum;
}

function runSamples(
  v: DataView,
  trun: Box,
  fallback: number | undefined,
  sum: Samples | undefined,
): Samples | undefined {
  const flags = v.getUint32(trun.start) & 0xffffff;
  const count = v.getUint32(trun.start + FULL_BOX_HEADER);
  let at = trun.start + 8;
  if (flags & TRUN_DATA_OFFSET) at += 4;
  if (flags & TRUN_FIRST_FLAGS) at += 4;
  if (!(flags & TRUN_DURATION)) {
    return fallback === undefined ? undefined : addSamples(sum, count, fallback);
  }
  const stride = TRUN_FIELDS.filter((f) => flags & f).length * 4;
  if (at + stride * count > trun.end) return undefined;
  let next = addSamples(sum, 0, 0);
  for (let i = 0; i < count; i++) next = addSamples(next, 1, v.getUint32(at + i * stride));
  return next;
}

/**
 * Decoded ticks: from the edit's start to the end of the sample it ends in.
 * `undefined` when the edit ends before the last sample begins.
 *
 * MPEG-4 audio (`mp4a`) decodes whole frames: a final sample whose `stts`
 * duration is shortened (how ffmpeg marks encoder padding) still decodes as
 * long as the frame before it.
 */
function decodedTicks(
  samples: Samples,
  edit: Edit,
  mediaScale: number,
  movieScale: number | undefined,
  wholeFrames: boolean,
): number | undefined {
  const lastStart = samples.ticks - samples.last;
  if (edit.duration > 0) {
    if (!movieScale) return undefined;
    const editEnd = edit.mediaTime + (edit.duration * mediaScale) / movieScale;
    if (editEnd <= lastStart) return undefined;
  }
  const frame =
    wholeFrames && samples.previous !== undefined
      ? Math.max(samples.last, samples.previous)
      : samples.last;
  return lastStart + frame - edit.mediaTime;
}

function positive(seconds: number): number | undefined {
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** What every track is read against: the top-level boxes, `moov`, and the movie timescale. */
interface Movie {
  top: Box[];
  moov: Box;
  scale?: number;
}

/** A track's `stts` samples, then its movie-fragment samples. */
function trackSamples(
  bytes: Uint8Array,
  movie: Movie,
  stbl: Box | undefined,
  trackId: number | undefined,
): Samples | undefined {
  const table = sttsSamples(bytes, stbl && descend(bytes, stbl, ['stts']));
  const fragments =
    trackId === undefined
      ? undefined
      : fragmentSamples(bytes, movie.top, trackId, trexDuration(bytes, movie.moov, trackId));
  if (!table || !fragments) return fragments ?? table;
  // Fragments follow the samples `moov` lists; the last sample is theirs.
  return {
    ticks: table.ticks + fragments.ticks,
    last: fragments.last,
    previous: fragments.previous ?? table.last,
  };
}

/** Presented seconds: the `tkhd` duration, else the samples' length. */
function presentedSeconds(
  duration: number | undefined,
  movie: Movie,
  samples: Samples | undefined,
  mediaScale: number | undefined,
): number | undefined {
  if (duration && movie.scale) return positive(duration / movie.scale);
  return samples && mediaScale ? positive(samples.ticks / mediaScale) : undefined;
}

function readTrack(bytes: Uint8Array, movie: Movie, trak: Box): Mp4Track | undefined {
  const tkhd = descend(bytes, trak, ['tkhd']);
  const hdlr = descend(bytes, trak, ['mdia', 'hdlr']);
  const mdhd = descend(bytes, trak, ['mdia', 'mdhd']);
  if (!tkhd || !hdlr || !mdhd || hdlr.start + HDLR_TYPE + 4 > hdlr.end) return undefined;
  const handler = ascii(bytes, hdlr.start + HDLR_TYPE, 4);
  const header = trackHeader(bytes, tkhd);
  const media = timedHeader(bytes, mdhd);
  const stbl = descend(bytes, trak, ['mdia', 'minf', 'stbl']);
  const stsd = stbl && descend(bytes, stbl, ['stsd']);
  const samples = trackSamples(bytes, movie, stbl, header?.id);
  const edit = soleEdit(bytes, descend(bytes, trak, ['edts', 'elst']));
  const wholeFrames = stsd !== undefined && sampleEntry(bytes, stsd) === MPEG4_AUDIO;
  const decoded =
    samples && media && edit
      ? decodedTicks(samples, edit, media.scale, movie.scale, wholeFrames)
      : undefined;
  return {
    handler,
    seconds: presentedSeconds(header?.duration, movie, samples, media?.scale),
    decodedSeconds: decoded === undefined || !media ? undefined : positive(decoded / media.scale),
    ...(handler === MP4_VIDEO && stsd ? visualSize(bytes, stsd) : undefined),
  };
}

/**
 * Every track of an ISO base media file, or `undefined` when the bytes do not
 * open with `ftyp` and hold a `moov`. Sample durations come from `stts`, then
 * any movie fragments.
 */
export function mp4Tracks(bytes: Uint8Array): Mp4Track[] | undefined {
  const top = boxes(bytes).list;
  const moov = top.find((b) => b.type === 'moov');
  if (top[0]?.type !== 'ftyp' || !moov) return undefined;
  const mvhd = descend(bytes, moov, ['mvhd']);
  const movie: Movie = { top, moov, scale: mvhd ? timedHeader(bytes, mvhd)?.scale : undefined };
  return childList(bytes, moov)
    .filter((b) => b.type === 'trak')
    .map((trak) => readTrack(bytes, movie, trak))
    .filter((track) => track !== undefined);
}
