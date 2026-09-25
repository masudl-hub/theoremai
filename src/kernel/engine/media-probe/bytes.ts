/**
 * Byte helpers shared by the media header readers.
 *
 * @module
 */

const ID3V2_HEADER = 10;
const ID3V2_FOOTER_FLAG = 0x10;
const SYNCSAFE_BITS = 7;

/** `length` bytes at `offset` as ASCII. */
export function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** DataView over exactly the bytes of `bytes`. */
export function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Unsigned 64-bit read as a JS number; `undefined` above 2^53. */
export function uint64(v: DataView, at: number, littleEndian = false): number | undefined {
  const high = v.getUint32(littleEndian ? at + 4 : at, littleEndian);
  const low = v.getUint32(littleEndian ? at : at + 4, littleEndian);
  const n = high * 2 ** 32 + low;
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Offset just past a leading ID3v2 tag, or 0 when there is none. */
export function id3v2End(bytes: Uint8Array): number {
  if (bytes.length < ID3V2_HEADER || ascii(bytes, 0, 3) !== 'ID3') return 0;
  let size = 0;
  for (let i = 6; i < ID3V2_HEADER; i++) size = (size << SYNCSAFE_BITS) | (bytes[i] & 0x7f);
  const footer = bytes[5] & ID3V2_FOOTER_FLAG ? ID3V2_HEADER : 0;
  return ID3V2_HEADER + size + footer;
}
