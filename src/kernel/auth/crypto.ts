/**
 * Web Crypto utilities for OAuth 2.1 PKCE and stateless sealed state envelopes.
 *
 * All operations use standard `crypto.subtle` and `crypto.getRandomValues`,
 * ensuring 100% portability across Node, Deno, Bun, Cloudflare Workers, and browsers.
 *
 * @module
 */

/** Encode Uint8Array to RFC 4648 base64url string without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode RFC 4648 base64url string to Uint8Array. */
export function fromBase64Url(base64url: string): Uint8Array {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch (err) {
    throw new Error(
      `Invalid base64url encoding: ${err instanceof Error ? err.message : String(err)}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

/**
 * Generate a cryptographically secure PKCE code verifier (RFC 7636 Section 4.1).
 * Length must be between 43 and 128 characters without modulo bias.
 */
export function generateCodeVerifier(length = 64): string {
  if (length < 43 || length > 128) {
    throw new RangeError(
      `Invalid PKCE code_verifier length: ${length}. RFC 7636 Section 4.1 requires length between 43 and 128 characters.`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const validChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const maxValid = 256 - (256 % validChars.length); // 198 (66 * 3) eliminates modulo bias
  let verifier = '';
  const buffer = new Uint8Array(length * 2);
  while (verifier.length < length) {
    crypto.getRandomValues(buffer);
    for (let i = 0; i < buffer.length && verifier.length < length; i++) {
      const val = buffer[i];
      if (val !== undefined && val < maxValid) {
        verifier += validChars[val % validChars.length];
      }
    }
  }
  return verifier;
}

/**
 * Compute the PKCE code challenge using S256 (RFC 7636 Section 4.2):
 * `BASE64URL(SHA256(ASCII(code_verifier)))`
 */
export async function computeCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toBase64Url(new Uint8Array(digest));
}

export interface SealedStatePayload {
  codeVerifier: string;
  expectedIssuer: string;
  resource?: string;
  redirectUri: string;
  expiresAt: number; // unix timestamp in ms
  clientId: string;
  extra?: Record<string, unknown>;
}

/**
 * Create a stateless HMAC-SHA256 signed envelope for OAuth `state`.
 * This allows a stateless backend to recover the code_verifier and expected issuer
 * upon receiving the OAuth callback, without any database or session cache.
 */
export async function sealStatePayload(
  payload: SealedStatePayload,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const jsonStr = JSON.stringify(payload);
  const payloadBytes = encoder.encode(jsonStr);
  const payloadB64 = toBase64Url(payloadBytes);

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret) as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(payloadB64) as unknown as BufferSource,
  );
  const signatureB64 = toBase64Url(new Uint8Array(signature));

  return `${payloadB64}.${signatureB64}`;
}

/**
 * Unpack and verify an HMAC-SHA256 signed `state` envelope.
 * Validates cryptographic signature and expiration timestamp.
 */
export async function unsealStatePayload(
  sealed: string,
  secret: string,
): Promise<SealedStatePayload> {
  const parts = sealed.split('.');
  if (parts.length !== 2) {
    throw new Error('Invalid sealed state format'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const [payloadB64, signatureB64] = parts;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret) as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const signatureBytes = fromBase64Url(signatureB64);
  const isValid = await crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes as unknown as BufferSource,
    encoder.encode(payloadB64) as unknown as BufferSource,
  );

  if (!isValid) {
    throw new Error(
      'OAuth state HMAC signature verification failed: state has been tampered with or corrupted', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }

  const payloadJson = new TextDecoder().decode(fromBase64Url(payloadB64));
  const payload = JSON.parse(payloadJson) as SealedStatePayload;

  if (Date.now() > payload.expiresAt) {
    throw new Error('OAuth state has expired'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }

  return payload;
}
