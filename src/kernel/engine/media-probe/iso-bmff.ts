/**
 * ISO base media file format (MP4, M4A, HEIF) box walking.
 *
 * @module
 */

import { ascii, uint64, view } from './bytes.ts';

const BOX_HEADER = 8;
const LARGE_SIZE = 1;
const TO_END = 0;
/** Major brand and minor version precede the compatible brands. */
const FTYP_COMPATIBLE = 8;
/** Version and flags that open every full box. */
export const FULL_BOX_HEADER = 4;

/** One box: its four-character type and where its payload sits. */
export interface Box {
  type: string;
  /** First payload byte (past size, type, and any large size). */
  start: number;
  /** One past the last payload byte. */
  end: number;
}

/**
 * Boxes laid end to end in `[start, end)`. Stops at the first box whose size
 * does not fit; `complete` says whether the walk reached `end` exactly.
 */
export function boxes(
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
): { list: Box[]; complete: boolean } {
  const v = view(bytes);
  const list: Box[] = [];
  let at = start;
  while (at + BOX_HEADER <= end) {
    const size32 = v.getUint32(at);
    const type = ascii(bytes, at + 4, 4);
    let header = BOX_HEADER;
    let size: number | undefined = size32;
    if (size32 === LARGE_SIZE) {
      if (at + BOX_HEADER * 2 > end) break;
      size = uint64(v, at + BOX_HEADER);
      header = BOX_HEADER * 2;
    } else if (size32 === TO_END) {
      size = end - at;
    }
    if (size === undefined || size < header || at + size > end) break;
    list.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return { list, complete: at === end };
}

/** True when the file opens with an `ftyp` box whose major or compatible brands meet `accept`. */
export function hasBrand(bytes: Uint8Array, accept: (brand: string) => boolean): boolean {
  const ftyp = boxes(bytes).list[0];
  return ftyp?.type === 'ftyp' && brands(bytes, ftyp).some(accept);
}

function brands(bytes: Uint8Array, ftyp: Box): string[] {
  const list = [ascii(bytes, ftyp.start, 4)];
  for (let at = ftyp.start + FTYP_COMPATIBLE; at + 4 <= ftyp.end; at += 4)
    list.push(ascii(bytes, at, 4));
  return list;
}
