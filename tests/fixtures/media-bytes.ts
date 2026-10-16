const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_LENGTH = 13;
const PNG_BIT_DEPTH = 8;
const PNG_COLOR_RGB = 2;

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** A PNG signature and IHDR: enough for a reader to take its size. */
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
