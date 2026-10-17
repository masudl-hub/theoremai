import { base64ToBytes } from '../util/base64.ts';

const HEX_PAD = 2;
const HEX_RADIX = 16;

function hexSha256(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(HEX_RADIX).padStart(HEX_PAD, '0')).join('');
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hexSha256(new Uint8Array(buf));
}

/** Hashes the decoded bytes, so the hash names the media whatever encoding carried it; `undefined` when not base64. */
export async function sha256Base64(
  base64: string,
): Promise<{ hash: string; bytes: number } | undefined> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = base64ToBytes(base64);
  } catch {
    return undefined;
  }
  const buf = await crypto.subtle.digest('SHA-256', raw);
  return { hash: hexSha256(new Uint8Array(buf)), bytes: raw.byteLength };
}
