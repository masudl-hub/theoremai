/**
 * Base64 ⇄ bytes — the one codec for inline media payloads.
 *
 * @module
 */

/** Decode base64 ASCII string to raw byte array. */
export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode raw byte array to base64 ASCII string. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
