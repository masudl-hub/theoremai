/**
 * Minimal media files for header readers and the token estimator — just the
 * bytes a header reader looks at, built to each format's spec.
 *
 * @module
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_LENGTH = 13;
const PNG_BIT_DEPTH = 8;
const PNG_COLOR_RGB = 2;
const JPEG_APP0_LENGTH = 16;
const JPEG_SOF_LENGTH = 17;
const JPEG_DHT_LENGTH = 4;
const JPEG_PRECISION = 8;
const JPEG_COMPONENTS = 3;
const WEBP_VP8X_CHUNK = 10;
const WEBP_VP8L_SIGNATURE = 0x2f;
const WEBP_VP8_START_CODE = [0x9d, 0x01, 0x2a];
const WAV_FMT_CHUNK = 16;
const WAV_PCM = 1;
const PCM_BYTES_PER_SAMPLE = 2;
const BITS_PER_BYTE = 8;

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

function u16be(n: number): number[] {
  return [(n >>> 8) & 0xff, n & 0xff];
}

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function u16le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}

function u24le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
}

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/** PNG signature plus IHDR. */
export function pngBytes(width: number, height: number): Uint8Array {
  return new Uint8Array([
    ...PNG_SIGNATURE,
    ...u32be(IHDR_LENGTH),
    ...ascii('IHDR'),
    ...u32be(width),
    ...u32be(height),
    PNG_BIT_DEPTH,
    PNG_COLOR_RGB,
    0,
    0,
    0,
    ...u32be(0),
  ]);
}

/** JPEG SOI, APP0 (JFIF), a DHT segment, a restart marker, then SOF0. */
export function jpegBytes(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...u16be(JPEG_APP0_LENGTH),
    ...ascii('JFIF'),
    0,
    1,
    1,
    0,
    ...u16be(1),
    ...u16be(1),
    0,
    0,
    0xff,
    0xc4,
    ...u16be(JPEG_DHT_LENGTH),
    0,
    0,
    0xff,
    0xd0,
    0xff,
    0xc0,
    ...u16be(JPEG_SOF_LENGTH),
    JPEG_PRECISION,
    ...u16be(height),
    ...u16be(width),
    JPEG_COMPONENTS,
    ...new Array(JPEG_COMPONENTS * 3).fill(0),
  ]);
}

/** GIF89a logical screen descriptor. */
export function gifBytes(width: number, height: number): Uint8Array {
  return new Uint8Array([...ascii('GIF89a'), ...u16le(width), ...u16le(height), 0, 0, 0]);
}

function riff(form: string, chunks: number[]): Uint8Array {
  return new Uint8Array([...ascii('RIFF'), ...u32le(4 + chunks.length), ...ascii(form), ...chunks]);
}

/** WebP in each of its three bitstream layouts. */
export function webpBytes(
  layout: 'VP8 ' | 'VP8L' | 'VP8X',
  width: number,
  height: number,
): Uint8Array {
  if (layout === 'VP8X') {
    return riff('WEBP', [
      ...ascii('VP8X'),
      ...u32le(WEBP_VP8X_CHUNK),
      ...u32le(0),
      ...u24le(width - 1),
      ...u24le(height - 1),
    ]);
  }
  if (layout === 'VP8L') {
    const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
    return riff('WEBP', [...ascii('VP8L'), ...u32le(5), WEBP_VP8L_SIGNATURE, ...u32le(bits)]);
  }
  return riff('WEBP', [
    ...ascii('VP8 '),
    ...u32le(10),
    0,
    0,
    0,
    ...WEBP_VP8_START_CODE,
    ...u16le(width),
    ...u16le(height),
  ]);
}

/** 16-bit PCM WAV with silent samples. `extra` inserts a chunk before `fmt `. */
export function wavBytes(
  seconds: number,
  options: { rate?: number; channels?: number; extra?: boolean } = {},
): Uint8Array {
  const rate = options.rate ?? 16_000;
  const channels = options.channels ?? 1;
  const byteRate = rate * channels * PCM_BYTES_PER_SAMPLE;
  const dataSize = Math.round(seconds * byteRate);
  const list = options.extra ? [...ascii('LIST'), ...u32le(3), 0, 0, 0, 0] : [];
  return riff('WAVE', [
    ...list,
    ...ascii('fmt '),
    ...u32le(WAV_FMT_CHUNK),
    ...u16le(WAV_PCM),
    ...u16le(channels),
    ...u32le(rate),
    ...u32le(byteRate),
    ...u16le(channels * PCM_BYTES_PER_SAMPLE),
    ...u16le(PCM_BYTES_PER_SAMPLE * BITS_PER_BYTE),
    ...ascii('data'),
    ...u32le(dataSize),
    ...new Array(dataSize).fill(0),
  ]);
}

/** Raw 16-bit PCM samples (no header). */
export function pcmBytes(seconds: number, rate: number, channels = 1): Uint8Array {
  return new Uint8Array(Math.round(seconds * rate * channels * PCM_BYTES_PER_SAMPLE));
}

const encoder = new TextEncoder();

function latin1Bytes(text: string): Uint8Array {
  return new Uint8Array([...text].map((c) => c.charCodeAt(0)));
}

async function deflate(text: string): Promise<Uint8Array> {
  const stream = new Blob([encoder.encode(text)])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function pageObjects(pages: number, treeRef: number, firstPage: number): string[] {
  return Array.from(
    { length: pages },
    (_, i) =>
      `${firstPage + i} 0 obj\n<< /Type /Page /Parent ${treeRef} 0 R /MediaBox [0 0 612 792] >>\nendobj\n`,
  );
}

function kids(pages: number, firstPage: number): string {
  return Array.from({ length: pages }, (_, i) => `${firstPage + i} 0 R`).join(' ');
}

/**
 * PDF with `pages` pages.
 * - `layout: 'flat'` — one page-tree root with every page as a kid.
 * - `layout: 'nested'` — root over two intermediate `/Pages` nodes.
 * - `layout: 'objectStream'` — catalog and page tree inside a FlateDecode object stream.
 * - `indirectLength` — the object stream's `/Length` is an indirect reference.
 * - `updatedTo` — an incremental update rewrites the root to that many pages.
 */
export async function pdfBytes(
  pages: number,
  options: {
    layout?: 'flat' | 'nested' | 'objectStream';
    indirectLength?: boolean;
    updatedTo?: number;
  } = {},
): Promise<Uint8Array> {
  const layout = options.layout ?? 'flat';
  const head = '%PDF-1.7\n%âãÏÓ\n';
  const parts: Uint8Array[] = [latin1Bytes(head)];
  if (layout === 'flat') {
    parts.push(
      latin1Bytes(
        [
          '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
          `2 0 obj\n<< /Type /Pages /Kids [${kids(pages, 3)}] /Count ${pages} >>\nendobj\n`,
          ...pageObjects(pages, 2, 3),
        ].join(''),
      ),
    );
  } else if (layout === 'nested') {
    const left = Math.ceil(pages / 2);
    const right = pages - left;
    parts.push(
      latin1Bytes(
        [
          '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
          `2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count ${pages} >>\nendobj\n`,
          `3 0 obj\n<< /Type /Pages /Parent 2 0 R /Kids [${kids(left, 5)}] /Count ${left} >>\nendobj\n`,
          `4 0 obj\n<< /Type /Pages /Parent 2 0 R /Kids [${kids(right, 5 + left)}] /Count ${right} >>\nendobj\n`,
          ...pageObjects(left, 3, 5),
          ...pageObjects(right, 4, 5 + left),
        ].join(''),
      ),
    );
  } else {
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      `<< /Type /Pages /Kids [${kids(pages, 4)}] /Count ${pages} >>`,
    ];
    const header = `1 0 2 ${objects[0].length + 1} `;
    const body = await deflate(`${header}${objects.join(' ')}`);
    const length = options.indirectLength ? '999 0 R' : String(body.length);
    parts.push(
      latin1Bytes(
        `3 0 obj\n<< /Type /ObjStm /N 2 /First ${header.length} /Filter /FlateDecode /Length ${length} >>\nstream\n`,
      ),
      body,
      latin1Bytes('\r\nendstream\nendobj\n'),
      ...(options.indirectLength ? [latin1Bytes(`999 0 obj\n${body.length}\nendobj\n`)] : []),
      latin1Bytes(pageObjects(pages, 2, 4).join('')),
    );
  }
  if (options.updatedTo !== undefined) {
    const firstNew = 1000;
    parts.push(
      latin1Bytes(
        [
          'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
          `2 0 obj\n<< /Type /Pages /Kids [${kids(options.updatedTo, firstNew)}] /Count ${options.updatedTo} >>\nendobj\n`,
          ...pageObjects(options.updatedTo, 2, firstNew),
        ].join(''),
      ),
    );
  }
  parts.push(latin1Bytes('trailer\n<< /Root 1 0 R >>\n%%EOF\n'));
  return concat(parts);
}

function u64le(n: number): number[] {
  return [...u32le(n % 2 ** 32), ...u32le(Math.floor(n / 2 ** 32))];
}

function u24be(n: number): number[] {
  return [(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** IEEE 754 80-bit extended encoding of a positive integer below 2^32. */
function extended80(n: number): number[] {
  const exponent = Math.floor(Math.log2(n));
  return [...u16be(exponent + 16383), ...u32be(n * 2 ** (31 - exponent)), ...u32be(0)];
}

/** AIFF with a padded odd-sized chunk before COMM; no sample data. */
export function aiffBytes(seconds: number, rate: number): Uint8Array {
  const name = [...ascii('NAME'), ...u32be(3), ...ascii('abc'), 0];
  const comm = [
    ...ascii('COMM'),
    ...u32be(18),
    ...u16be(1),
    ...u32be(Math.round(seconds * rate)),
    ...u16be(16),
    ...extended80(rate),
  ];
  const body = [...ascii('AIFF'), ...name, ...comm];
  return new Uint8Array([...ascii('FORM'), ...u32be(body.length), ...body]);
}

/** FLAC STREAMINFO body: 34 bytes with rate, mono, 16-bit, and total samples. */
function streamInfo(seconds: number, rate: number): number[] {
  const total = BigInt(Math.round(seconds * rate));
  const packed = (BigInt(rate) << 44n) | (0n << 41n) | (15n << 36n) | total;
  const eight = Array.from({ length: 8 }, (_, i) => Number((packed >> BigInt(56 - i * 8)) & 0xffn));
  return [
    ...u16be(4096),
    ...u16be(4096),
    ...u24be(0),
    ...u24be(0),
    ...eight,
    ...new Array(16).fill(0),
  ];
}

/** Native FLAC: `fLaC` and a STREAMINFO block, optionally behind an ID3v2 tag. */
export function flacBytes(
  seconds: number,
  rate: number,
  options: { id3?: boolean } = {},
): Uint8Array {
  const id3 = options.id3 ? [...ascii('ID3'), 4, 0, 0, 0, 0, 1, 0, ...new Array(128).fill(0)] : [];
  return new Uint8Array([
    ...id3,
    ...ascii('fLaC'),
    0x80,
    ...u24be(34),
    ...streamInfo(seconds, rate),
  ]);
}

function oggPage(
  serial: number,
  granule: number | undefined,
  payload: number[],
  first = false,
): number[] {
  const granuleBytes = granule === undefined ? new Array(8).fill(0xff) : u64le(granule);
  return [
    ...ascii('OggS'),
    0,
    first ? 0x02 : 0,
    ...granuleBytes,
    ...u32le(serial),
    ...u32le(0),
    ...u32le(0),
    1,
    payload.length,
    ...payload,
  ];
}

/**
 * Ogg stream of one codec: identification page, a page that completes no
 * packet, the final page, then a page of a second logical stream with a larger
 * granule that must be ignored.
 */
export function oggBytes(
  codec: 'opus' | 'vorbis' | 'flac',
  seconds: number,
  rate: number,
  preSkip = 0,
): Uint8Array {
  const serial = 7;
  let head: number[];
  let granule: number;
  if (codec === 'opus') {
    head = [...ascii('OpusHead'), 1, 1, ...u16le(preSkip), ...u32le(rate), 0, 0, 0];
    granule = preSkip + Math.round(seconds * 48_000);
  } else if (codec === 'vorbis') {
    head = [
      1,
      ...ascii('vorbis'),
      ...u32le(0),
      1,
      ...u32le(rate),
      ...new Array(12).fill(0),
      0xb8,
      1,
    ];
    granule = Math.round(seconds * rate);
  } else {
    head = [
      0x7f,
      ...ascii('FLAC'),
      1,
      0,
      ...u16be(1),
      ...ascii('fLaC'),
      0x80,
      ...u24be(34),
      ...streamInfo(seconds, rate),
    ];
    granule = Math.round(seconds * rate);
  }
  return new Uint8Array([
    ...oggPage(serial, 0, head, true),
    ...oggPage(serial, undefined, [1, 2, 3]),
    ...oggPage(serial, granule, [4, 5, 6]),
    ...oggPage(serial + 1, granule * 10, [7]),
  ]);
}

/** EBML element with a minimal-length size, or the all-ones unknown size. */
function ebml(id: number[], body: number[], unknownSize = false): number[] {
  if (unknownSize) return [...id, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...body];
  const n = body.length;
  const size =
    n < 0x7f ? [0x80 | n] : n < 0x3fff ? [0x40 | (n >> 8), n & 0xff] : [0x10, ...u24be(n)];
  return [...id, ...size, ...body];
}

function ebmlUint(id: number[], n: number): number[] {
  return ebml(id, n < 256 ? [n] : n < 65_536 ? u16be(n) : n < 16_777_216 ? u24be(n) : u32be(n));
}

function float64be(n: number): number[] {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, n);
  return [...out];
}

const OPUS_CELT_20MS_TOC = (31 << 3) | 0;

/**
 * WebM with one Opus audio track (`packets` packets of 20 ms) and one VP9 video
 * track, laid into one-second clusters.
 * - `duration` — Info carries this Duration in seconds (what a seekable muxer
 *   writes). Absent: live-recorder shape — unknown-size Segment and Clusters.
 * - `codecDelayNs` — the audio track's CodecDelay.
 * - `discardNs` — the last audio packet sits in a BlockGroup with this DiscardPadding.
 * - `laced` — audio blocks use Xiph lacing, so the packet TOC cannot be read.
 * - `video` — `frames` frames every `frameMs` at `width`×`height`, stating
 *   `DefaultDuration` when `defaultDuration`; `reorder` swaps each pair of
 *   frame timestamps, as B-frames store them (use an even `frames`). Without it the video track holds
 *   one 640×360 frame per cluster at 999 ms.
 */
export function webmBytes(
  packets: number,
  options: {
    duration?: number;
    codecDelayNs?: number;
    discardNs?: number;
    laced?: boolean;
    video?: {
      frames: number;
      frameMs: number;
      width: number;
      height: number;
      defaultDuration?: boolean;
      reorder?: boolean;
    };
  } = {},
): Uint8Array {
  const live = options.duration === undefined;
  const video = options.video;
  const header = ebml([0x1a, 0x45, 0xdf, 0xa3], ebml([0x42, 0x82], [...ascii('webm')]));
  const info = ebml(
    [0x15, 0x49, 0xa9, 0x66],
    [
      ...ebmlUint([0x2a, 0xd7, 0xb1], 1_000_000),
      ...(live ? [] : ebml([0x44, 0x89], float64be((options.duration ?? 0) * 1000))),
    ],
  );
  const track = (n: number, type: number, codec: string, extra: number[] = []) =>
    ebml(
      [0xae],
      [
        ...ebmlUint([0xd7], n),
        ...ebmlUint([0x83], type),
        ...ebml([0x86], [...ascii(codec)]),
        ...extra,
      ],
    );
  const codecDelay = options.codecDelayNs ? ebmlUint([0x56, 0xaa], options.codecDelayNs) : [];
  const pixels = ebml(
    [0xe0],
    [...ebmlUint([0xb0], video?.width ?? 640), ...ebmlUint([0xba], video?.height ?? 360)],
  );
  const defaultDuration = video?.defaultDuration
    ? ebmlUint([0x23, 0xe3, 0x83], video.frameMs * 1_000_000)
    : [];
  const tracks = ebml(
    [0x16, 0x54, 0xae, 0x6b],
    [
      ...track(1, 2, 'A_OPUS', codecDelay),
      ...track(2, 1, 'V_VP9', [...defaultDuration, ...pixels]),
    ],
  );
  const videoMs = video
    ? Array.from(
        { length: video.frames },
        (_, f) => (video.reorder ? f + (f % 2 === 0 ? 1 : -1) : f) * video.frameMs,
      )
    : [];
  const spanMs = Math.max(packets * 20, video ? video.frames * video.frameMs : 0);
  const clusters: number[] = [];
  for (let startMs = 0; startMs < spanMs; startMs += 1000) {
    const blocks: number[] = [];
    for (let p = startMs / 20; p < Math.min(packets, (startMs + 1000) / 20); p++) {
      const flags = options.laced ? 0x02 : 0;
      const block = [0x81, ...u16be(p * 20 - startMs), flags, OPUS_CELT_20MS_TOC, 0];
      if (p === packets - 1 && options.discardNs !== undefined) {
        blocks.push(
          ...ebml(
            [0xa0],
            [...ebml([0xa1], block), ...ebml([0x75, 0xa2], u32be(options.discardNs))],
          ),
        );
      } else {
        blocks.push(...ebml([0xa3], [...block.slice(0, 3), 0x80 | flags, ...block.slice(4)]));
      }
    }
    const frames = video
      ? videoMs.filter((ms) => ms >= startMs && ms < startMs + 1000)
      : [startMs + 999];
    for (const ms of frames) blocks.push(...ebml([0xa3], [0x82, ...u16be(ms - startMs), 0x80, 0]));
    clusters.push(
      ...ebml([0x1f, 0x43, 0xb6, 0x75], [...ebmlUint([0xe7], startMs), ...blocks], live),
    );
  }
  const segment = ebml([0x18, 0x53, 0x80, 0x67], [...info, ...tracks, ...clusters], live);
  return new Uint8Array([...header, ...segment]);
}

function box(type: string, body: number[]): number[] {
  return [...u32be(8 + body.length), ...ascii(type), ...body];
}

function fullBox(type: string, version: number, flags: number, body: number[]): number[] {
  return box(type, [version, ...u24be(flags), ...body]);
}

const MP4_SOUND_ID = 3;
const MP4_VIDEO_ID = 4;
const MP4_MOVIE_SCALE = 1000;
const MP4_SOUND_SCALE = 48_000;
const MP4_VIDEO_SCALE = 12_288;
const AAC_SAMPLES = 1024;

/** Version 0 or 1 full-box body: creation and modification times, then the given fields. */
function timed(version: 0 | 1, fields: number[], duration: number): number[] {
  return version === 1
    ? [
        ...new Array(16).fill(0),
        ...fields,
        ...u32be(Math.floor(duration / 2 ** 32)),
        ...u32be(duration >>> 0),
      ]
    : [...new Array(8).fill(0), ...fields, ...u32be(duration)];
}

function i64be(n: number): number[] {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(n));
  return [...out];
}

/** `edts/elst` of `[segment duration (movie ticks), media time]` entries. */
function edits(version: 0 | 1, entries: [number, number][]): number[] {
  const body = entries.flatMap(([duration, mediaTime]) =>
    version === 1
      ? [...i64be(duration), ...i64be(mediaTime), ...u32be(0x10000)]
      : [...u32be(duration), ...u32be(mediaTime >>> 0), ...u32be(0x10000)],
  );
  return box('edts', fullBox('elst', version, 0, [...u32be(entries.length), ...body]));
}

interface Mp4Trak {
  id: number;
  handler: 'soun' | 'vide';
  scale: number;
  /** `[count, delta]` runs for `stts`; empty for a fragmented track. */
  runs: [number, number][];
  /** `tkhd` duration, movie timescale. */
  presented: number;
  entry: number[];
  elst?: [number, number][];
}

function trak(t: Mp4Trak, version: 0 | 1): number[] {
  const ticks = t.runs.reduce((sum, [count, delta]) => sum + count * delta, 0);
  const tkhdFields = [...u32be(t.id), ...u32be(0)];
  return box('trak', [
    ...fullBox('tkhd', version, 3, [
      ...timed(version, tkhdFields, t.presented),
      ...new Array(60).fill(0),
    ]),
    ...(t.elst ? edits(version, t.elst) : []),
    ...box('mdia', [
      ...fullBox('mdhd', version, 0, [...timed(version, u32be(t.scale), ticks), 0, 0, 0, 0]),
      ...fullBox('hdlr', 0, 0, [...u32be(0), ...ascii(t.handler), ...new Array(12).fill(0), 0]),
      ...box(
        'minf',
        box('stbl', [
          ...fullBox('stsd', 0, 0, [...u32be(1), ...t.entry]),
          ...fullBox('stts', 0, 0, [
            ...u32be(t.runs.length),
            ...t.runs.flatMap(([c, d]) => [...u32be(c), ...u32be(d)]),
          ]),
        ]),
      ),
    ]),
  ]);
}

/**
 * MP4 with an optional AAC sound track (48 kHz, 1024-sample frames) and an
 * optional H.264 video track (12 288 Hz media clock).
 * - `audio.frames` — AAC frames. `priming` samples open an edit list whose
 *   segment plays `seconds` (default: the frames less priming and `lastShort`).
 *   `lastShort` shortens the final frame's `stts` duration, as ffmpeg marks
 *   padding. `edits` replaces the edit list outright.
 * - `video` — `frames` frames of `delta` ticks at `width`×`height`; `tkhd`
 *   presents `seconds` (default: the frames' length).
 * - `fragmented` — the sound track's samples live in movie fragments: one run
 *   with per-sample durations and one on the `trex` default.
 * - `version: 1` — 64-bit `mvhd`, `tkhd`, `mdhd`, and `elst`.
 */
export function mp4Bytes(options: {
  audio?: {
    frames: number;
    priming?: number;
    lastShort?: number;
    seconds?: number;
    edits?: [number, number][];
  };
  video?: { frames: number; delta: number; width: number; height: number; seconds?: number };
  fragmented?: boolean;
  version?: 0 | 1;
}): Uint8Array {
  const version = options.version ?? 0;
  const ftyp = box('ftyp', [...ascii('isom'), ...u32be(0), ...ascii('isom'), ...ascii('mp42')]);
  const traks: number[] = [];
  const { audio, video } = options;
  if (audio) {
    const priming = audio.priming ?? 0;
    const short = audio.lastShort ?? 0;
    const ticks = audio.frames * AAC_SAMPLES - short;
    const runs: [number, number][] = short
      ? [
          [audio.frames - 1, AAC_SAMPLES],
          [1, AAC_SAMPLES - short],
        ]
      : [[audio.frames, AAC_SAMPLES]];
    const played = audio.seconds ?? (ticks - priming) / MP4_SOUND_SCALE;
    const elst: [number, number][] | undefined =
      audio.edits ?? (priming ? [[Math.round(played * MP4_MOVIE_SCALE), priming]] : undefined);
    traks.push(
      ...trak(
        {
          id: MP4_SOUND_ID,
          handler: 'soun',
          scale: MP4_SOUND_SCALE,
          runs: options.fragmented ? [] : runs,
          presented: options.fragmented ? 0 : Math.round(played * MP4_MOVIE_SCALE),
          entry: box('mp4a', new Array(28).fill(0)),
          elst,
        },
        version,
      ),
    );
  }
  if (video) {
    const visual = [
      ...new Array(24).fill(0),
      ...u16be(video.width),
      ...u16be(video.height),
      ...new Array(50).fill(0),
    ];
    traks.push(
      ...trak(
        {
          id: MP4_VIDEO_ID,
          handler: 'vide',
          scale: MP4_VIDEO_SCALE,
          runs: [[video.frames, video.delta]],
          presented: Math.round(
            (video.seconds ?? (video.frames * video.delta) / MP4_VIDEO_SCALE) * MP4_MOVIE_SCALE,
          ),
          entry: box('avc1', visual),
        },
        version,
      ),
    );
  }
  const mvhd = fullBox('mvhd', version, 0, [
    ...timed(version, u32be(MP4_MOVIE_SCALE), 0),
    ...new Array(80).fill(0),
  ]);
  if (!options.fragmented || !audio) {
    return new Uint8Array([...ftyp, ...box('moov', [...mvhd, ...traks]), ...box('mdat', [0, 0])]);
  }
  const trex = fullBox('trex', 0, 0, [
    ...u32be(MP4_SOUND_ID),
    ...u32be(1),
    ...u32be(AAC_SAMPLES),
    ...u32be(0),
    ...u32be(0),
  ]);
  const moov = box('moov', [...mvhd, ...traks, ...box('mvex', trex)]);
  const first = Math.floor(audio.frames / 2);
  const rest = audio.frames - first;
  const withDurations = fullBox('trun', 0, 0x301, [
    ...u32be(first),
    ...u32be(0),
    ...Array.from({ length: first }, () => [...u32be(AAC_SAMPLES), ...u32be(10)]).flat(),
  ]);
  const onDefault = fullBox('trun', 0, 0x201, [
    ...u32be(rest),
    ...u32be(0),
    ...Array.from({ length: rest }, () => u32be(10)).flat(),
  ]);
  const otherTrack = box('traf', [
    ...fullBox('tfhd', 0, 0x08, [...u32be(MP4_SOUND_ID + 10), ...u32be(99_999)]),
    ...fullBox('trun', 0, 0, u32be(50)),
  ]);
  const traf = box('traf', [
    ...fullBox('tfhd', 0, 0x020000, u32be(MP4_SOUND_ID)),
    ...withDurations,
    ...onDefault,
  ]);
  const moof = box('moof', [...fullBox('mfhd', 0, 0, u32be(1)), ...traf, ...otherTrack]);
  return new Uint8Array([...ftyp, ...moov, ...moof, ...box('mdat', [0, 0])]);
}

/** MPEG-1 Layer III, 128 kbit/s, 44.1 kHz, stereo — 417-byte frames of 1152 samples. */
const MP3_V1_HEADER = [0xff, 0xfb, 0x90, 0x00];
const MP3_V1_FRAME = 417;
/** MPEG-2 Layer III, 32 kbit/s, 22.05 kHz, mono — 104-byte frames of 576 samples. */
const MP3_V2_HEADER = [0xff, 0xf3, 0x40, 0xc0];
const MP3_V2_FRAME = 104;

/**
 * MP3 of `frames` frames.
 * - `tag: 'xing' | 'vbri'` — a first frame carrying a frame-count tag (the
 *   count excludes the tag frame); the frames after it are not walked.
 * - `tag: 'none'` — plain frames, walked to the end.
 * - `id3` prefixes an ID3v2 tag; `trailer` appends an ID3v1 tag or garbage.
 * - `mpeg2` — MPEG-2 Layer III frames.
 * - `lame` — a LAME info tag after the Xing fields, declaring encoder delay and padding.
 */
export function mp3Bytes(
  frames: number,
  options: {
    tag: 'xing' | 'vbri' | 'none';
    id3?: boolean;
    trailer?: 'id3v1' | 'garbage';
    mpeg2?: boolean;
    lame?: { encoder: string; delay: number; padding: number };
  },
): Uint8Array {
  const header = options.mpeg2 ? MP3_V2_HEADER : MP3_V1_HEADER;
  const size = options.mpeg2 ? MP3_V2_FRAME : MP3_V1_FRAME;
  const frame = (payload: number[] = []) => [
    ...header,
    ...payload,
    ...new Array(size - 4 - payload.length).fill(0),
  ];
  const sideInfo = options.mpeg2 ? 9 : 32;
  const out: number[] = [];
  if (options.id3) out.push(...ascii('ID3'), 3, 0, 0, 0, 0, 0, 20, ...new Array(20).fill(0));
  const lame = options.lame
    ? [
        ...ascii(options.lame.encoder.padEnd(9, ' ')),
        ...new Array(12).fill(0),
        ...u24be((options.lame.delay << 12) | options.lame.padding),
      ]
    : [];
  if (options.tag === 'xing') {
    out.push(
      ...frame([
        ...new Array(sideInfo).fill(0),
        ...ascii('Xing'),
        ...u32be(1),
        ...u32be(frames),
        ...lame,
      ]),
    );
  }
  if (options.tag === 'vbri')
    out.push(
      ...frame([
        ...new Array(32).fill(0),
        ...ascii('VBRI'),
        ...u16be(1),
        ...u16be(0),
        ...u16be(0),
        ...u32be(0),
        ...u32be(frames),
      ]),
    );
  const plain = options.tag === 'none' ? frames : 1;
  for (let i = 0; i < plain; i++) out.push(...frame());
  if (options.trailer === 'id3v1') out.push(...ascii('TAG'), ...new Array(125).fill(0));
  if (options.trailer === 'garbage') out.push(1, 2, 3, 4, 5);
  return new Uint8Array(out);
}

const ADTS_48K = 3;

/** AAC ADTS: `frames` 16-byte frames at 48 kHz, one raw block (1024 samples) each. */
export function adtsBytes(frames: number): Uint8Array {
  const length = 16;
  const header = [
    0xff,
    0xf1,
    (1 << 6) | (ADTS_48K << 2),
    (1 << 6) | ((length >> 11) & 0x03),
    (length >> 3) & 0xff,
    ((length & 0x07) << 5) | 0x1f,
    0xfc,
  ];
  return new Uint8Array(
    Array.from({ length: frames }, () => [...header, ...new Array(length - 7).fill(0)]).flat(),
  );
}

/**
 * HEIC shaped like a phone photo: primary item 1 is a grid whose `ispe` holds
 * the full size; tile item 2 has a 512×512 `ispe` and is listed first in
 * `ipma`. `clap` associates a clean-aperture crop with the primary item.
 */
export function heicBytes(
  width: number,
  height: number,
  options: { clap?: boolean } = {},
): Uint8Array {
  const ispe = (w: number, h: number) => fullBox('ispe', 0, 0, [...u32be(w), ...u32be(h)]);
  const ipco = box('ipco', [
    ...ispe(512, 512),
    ...ispe(width, height),
    ...(options.clap ? box('clap', new Array(32).fill(0)) : []),
  ]);
  const primaryProps = options.clap ? [0x82, 0x03] : [0x82];
  const ipma = fullBox('ipma', 0, 0, [
    ...u32be(2),
    ...u16be(2),
    1,
    0x81,
    ...u16be(1),
    primaryProps.length,
    ...primaryProps,
  ]);
  const meta = fullBox('meta', 0, 0, [
    ...fullBox('hdlr', 0, 0, [...u32be(0), ...ascii('pict'), ...new Array(12).fill(0), 0]),
    ...fullBox('pitm', 0, 0, u16be(1)),
    ...box('iprp', [...ipco, ...ipma]),
  ]);
  return new Uint8Array([
    ...box('ftyp', [...ascii('heic'), ...u32be(0), ...ascii('mif1'), ...ascii('heic')]),
    ...meta,
  ]);
}
