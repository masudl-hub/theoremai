/**
 * Image pixel size from headers — PNG, JPEG, GIF, WebP, and HEIF / HEIC.
 * Pixels are never decoded.
 *
 * @module
 */

import { ascii, view } from './bytes.ts';
import { type Box, boxes, FULL_BOX_HEADER, hasBrand } from './iso-bmff.ts';

/** Pixel dimensions of an image. */
export interface ImageSize {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
const GIF_WIDTH_OFFSET = 6;
const GIF_HEIGHT_OFFSET = 8;
const JPEG_SOI = 0xd8;
const JPEG_MARKER = 0xff;
const JPEG_SOF_FIRST = 0xc0;
const JPEG_SOF_LAST = 0xcf;
/** DHT, JPG extension, DAC — in the SOF range but not frame headers. */
const JPEG_NOT_SOF = new Set([0xc4, 0xc8, 0xcc]);
const JPEG_STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
const WEBP_CHUNK_OFFSET = 12;
const WEBP_VP8_SIZE_OFFSET = 26;
const WEBP_VP8L_SIZE_OFFSET = 21;
const WEBP_VP8X_SIZE_OFFSET = 24;
const FOURTEEN_BITS = 0x3fff;
const CHUNK_HEADER = 8;

function positive(size: ImageSize): ImageSize | undefined {
  return size.width > 0 && size.height > 0 ? size : undefined;
}

function pngSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < PNG_HEIGHT_OFFSET + 4) return undefined;
  if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return undefined;
  const v = view(bytes);
  return positive({
    width: v.getUint32(PNG_WIDTH_OFFSET),
    height: v.getUint32(PNG_HEIGHT_OFFSET),
  });
}

function gifSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < GIF_HEIGHT_OFFSET + 2 || ascii(bytes, 0, 3) !== 'GIF') return undefined;
  const v = view(bytes);
  return positive({
    width: v.getUint16(GIF_WIDTH_OFFSET, true),
    height: v.getUint16(GIF_HEIGHT_OFFSET, true),
  });
}

function jpegSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes[0] !== JPEG_MARKER || bytes[1] !== JPEG_SOI) return undefined;
  const v = view(bytes);
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== JPEG_MARKER) return undefined;
    const marker = bytes[at + 1];
    if (marker === JPEG_MARKER) {
      at += 1;
      continue;
    }
    if (JPEG_STANDALONE.has(marker)) {
      at += 2;
      continue;
    }
    const length = v.getUint16(at + 2);
    if (marker >= JPEG_SOF_FIRST && marker <= JPEG_SOF_LAST && !JPEG_NOT_SOF.has(marker)) {
      if (at + 9 > bytes.length) return undefined;
      return positive({ height: v.getUint16(at + 5), width: v.getUint16(at + 7) });
    }
    at += 2 + length;
  }
  return undefined;
}

function webpSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < WEBP_CHUNK_OFFSET + CHUNK_HEADER) return undefined;
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return undefined;
  const v = view(bytes);
  const chunk = ascii(bytes, WEBP_CHUNK_OFFSET, 4);
  if (chunk === 'VP8 ' && bytes.length >= WEBP_VP8_SIZE_OFFSET + 4) {
    return positive({
      width: v.getUint16(WEBP_VP8_SIZE_OFFSET, true) & FOURTEEN_BITS,
      height: v.getUint16(WEBP_VP8_SIZE_OFFSET + 2, true) & FOURTEEN_BITS,
    });
  }
  if (chunk === 'VP8L' && bytes.length >= WEBP_VP8L_SIZE_OFFSET + 4) {
    const bits = v.getUint32(WEBP_VP8L_SIZE_OFFSET, true);
    return positive({
      width: (bits & FOURTEEN_BITS) + 1,
      height: ((bits >>> 14) & FOURTEEN_BITS) + 1,
    });
  }
  if (chunk === 'VP8X' && bytes.length >= WEBP_VP8X_SIZE_OFFSET + 6) {
    const u24 = (at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
    return positive({
      width: u24(WEBP_VP8X_SIZE_OFFSET) + 1,
      height: u24(WEBP_VP8X_SIZE_OFFSET + 3) + 1,
    });
  }
  return undefined;
}

/** HEIF brands (ISO/IEC 23008-12): image, image sequence, and HEVC variants. */
const HEIF_BRANDS = new Set(['mif1', 'msf1', 'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx']);
const IPMA_WIDE_INDEX = 0x01;
const IPMA_INDEX_MASK_WIDE = 0x7fff;
const IPMA_INDEX_MASK = 0x7f;

/** Property indices (1-based into `ipco`) associated with `itemId` in an `ipma` box. */
function itemProperties(bytes: Uint8Array, ipma: Box, itemId: number): number[] | undefined {
  const v = view(bytes);
  const version = bytes[ipma.start];
  const wide = v.getUint32(ipma.start) & IPMA_WIDE_INDEX;
  let at = ipma.start + FULL_BOX_HEADER;
  if (at + 4 > ipma.end) return undefined;
  const entries = v.getUint32(at);
  at += 4;
  for (let e = 0; e < entries; e++) {
    const idSize = version < 1 ? 2 : 4;
    if (at + idSize + 1 > ipma.end) return undefined;
    const id = idSize === 2 ? v.getUint16(at) : v.getUint32(at);
    const count = bytes[at + idSize];
    at += idSize + 1;
    const indexSize = wide ? 2 : 1;
    if (at + count * indexSize > ipma.end) return undefined;
    if (id === itemId) {
      return Array.from({ length: count }, (_, i) =>
        wide ? v.getUint16(at + i * 2) & IPMA_INDEX_MASK_WIDE : bytes[at + i] & IPMA_INDEX_MASK,
      );
    }
    at += count * indexSize;
  }
  return undefined;
}

/**
 * HEIF / HEIC size: the `ispe` property of the primary item (`pitm`), which
 * for a tiled photo is the grid's full size. `undefined` when the primary item
 * also carries a clean-aperture crop (`clap`) — the delivered size differs.
 */
function heifSize(bytes: Uint8Array): ImageSize | undefined {
  if (!hasBrand(bytes, (brand) => HEIF_BRANDS.has(brand))) return undefined;
  const meta = boxes(bytes).list.find((b) => b.type === 'meta');
  if (!meta) return undefined;
  const inner = boxes(bytes, meta.start + FULL_BOX_HEADER, meta.end).list;
  const pitm = inner.find((b) => b.type === 'pitm');
  const iprp = inner.find((b) => b.type === 'iprp');
  if (!pitm || !iprp || pitm.start + FULL_BOX_HEADER + 2 > pitm.end) return undefined;
  const v = view(bytes);
  const primary =
    bytes[pitm.start] === 0
      ? v.getUint16(pitm.start + FULL_BOX_HEADER)
      : v.getUint32(pitm.start + FULL_BOX_HEADER);
  const props = boxes(bytes, iprp.start, iprp.end).list;
  const ipco = props.find((b) => b.type === 'ipco');
  const ipma = props.find((b) => b.type === 'ipma');
  if (!ipco || !ipma) return undefined;
  const list = boxes(bytes, ipco.start, ipco.end).list;
  const associated = itemProperties(bytes, ipma, primary)?.map((i) => list[i - 1]);
  if (!associated || associated.some((b) => b?.type === 'clap')) return undefined;
  const ispe = associated.find((b) => b?.type === 'ispe');
  if (!ispe || ispe.start + FULL_BOX_HEADER + 8 > ispe.end) return undefined;
  return positive({
    width: v.getUint32(ispe.start + FULL_BOX_HEADER),
    height: v.getUint32(ispe.start + FULL_BOX_HEADER + 4),
  });
}

/** Pixel size from a PNG, JPEG, GIF, WebP, or HEIF / HEIC header; `undefined` for anything else. */
export function imageSize(bytes: Uint8Array): ImageSize | undefined {
  return pngSize(bytes) ?? jpegSize(bytes) ?? gifSize(bytes) ?? webpSize(bytes) ?? heifSize(bytes);
}
