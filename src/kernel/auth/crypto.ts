import { base64ToBytes, bytesToBase64 } from '../util/base64.ts';

/** RFC 4648 base64url, without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(base64url: string): Uint8Array<ArrayBuffer> {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  try {
    return base64ToBytes(base64);
  } catch (err) {
    throw new Error(
      `Invalid base64url encoding: ${err instanceof Error ? err.message : String(err)}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

/** RFC 7636 §4.1: 43 to 128 characters, drawn without modulo bias. */
export function generateCodeVerifier(length = 64): string {
  if (length < 43 || length > 128) {
    throw new RangeError(
      `Invalid PKCE code_verifier length: ${length}. RFC 7636 Section 4.1 requires length between 43 and 128 characters.`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const validChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const maxValid = 256 - (256 % validChars.length); // 198 (66 * 3): rejecting above it removes modulo bias
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

/** RFC 7636 §4.2 S256. */
export async function computeCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toBase64Url(new Uint8Array(digest));
}

export interface SealedStatePayload {
  codeVerifier: string;
  expectedIssuer: string;
  /** RFC 9207: a response without `iss` is refused. */
  issRequired: boolean;
  /** Fixed when the flow began. */
  tokenEndpoint: string;
  resource: string;
  redirectUri: string;
  /** Epoch milliseconds. */
  expiresAt: number; // epoch ms
  clientId: string;
  /** SHA-256 of the host's session binding. */
  sessionBinding: string;
}

/** A secret shorter than 256 bits would be the weak link. */
const MIN_SECRET_BYTES = 32;

/** So this key is never the same as any other use of the host's secret. */
const STATE_KEY_INFO = 'theorem/oauth-state/v1';

const IV_BYTES = 12;

/** A fresh salt per state gives every state its own key, so no key sees enough random nonces for one to repeat. */
const SALT_BYTES = 32;

/** Authenticated with the ciphertext, so a later scheme can be told apart and an old one is never guessed at. */
const ENVELOPE_VERSION = 'v1';

async function stateKey(secret: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const secretBytes = encoder.encode(secret);
  if (secretBytes.length < MIN_SECRET_BYTES) {
    throw new RangeError(
      `OAuth state secret must be at least ${MIN_SECRET_BYTES} bytes; got ${secretBytes.length}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const base = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt,
      info: encoder.encode(STATE_KEY_INFO),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function envelopeHeader(): BufferSource {
  return new TextEncoder().encode(ENVELOPE_VERSION);
}

/** Encrypted, not only signed: the state crosses the browser and the server, and the PKCE verifier must stay secret. */
export async function sealStatePayload(
  payload: SealedStatePayload,
  secret: string,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await stateKey(secret, salt);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv, additionalData: envelopeHeader() },
    key,
    plaintext,
  );
  return [
    ENVELOPE_VERSION,
    toBase64Url(salt),
    toBase64Url(iv),
    toBase64Url(new Uint8Array(ciphertext)),
  ].join('.');
}

export async function unsealStatePayload(
  sealed: string,
  secret: string,
): Promise<SealedStatePayload> {
  const [version, saltB64, ivB64, ciphertextB64, ...rest] = sealed.split('.');
  if (version !== ENVELOPE_VERSION || ciphertextB64 === undefined || rest.length > 0) {
    throw new Error('Invalid sealed state format'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const key = await stateKey(secret, fromBase64Url(saltB64 ?? ''));
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(ivB64 ?? ''),
        additionalData: envelopeHeader(),
      },
      key,
      fromBase64Url(ciphertextB64 ?? ''),
    );
  } catch {
    throw new Error(
      'OAuth state could not be opened: it was tampered with, corrupted, or sealed with another secret', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }

  const payload = JSON.parse(new TextDecoder().decode(plaintext)) as SealedStatePayload;
  if (Date.now() > payload.expiresAt) {
    throw new Error('OAuth state has expired'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return payload;
}
