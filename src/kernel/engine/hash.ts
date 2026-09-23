const HEX_PAD = 2;
const HEX_RADIX = 16;

function hexSha256(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(HEX_RADIX).padStart(HEX_PAD, '0')).join('');
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hexSha256(new Uint8Array(buf));
}

/**
 * Hash base64 media over its raw bytes, so a hash names the media itself
 * whichever encoding carried it. Returns the decoded length too, or
 * `undefined` when the text is not base64 (the caller labels what it holds).
 */
export async function sha256Base64(
  base64: string,
): Promise<{ hash: string; bytes: number } | undefined> {
  let decoded: string;
  try {
    decoded = atob(base64);
  } catch {
    return undefined;
  }
  const raw = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  const buf = await crypto.subtle.digest('SHA-256', raw);
  return { hash: hexSha256(new Uint8Array(buf)), bytes: raw.byteLength };
}
