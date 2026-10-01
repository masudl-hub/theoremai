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
  /** The scopes the flow asked for; a grant may hold none beyond them. Empty asks for the server's default. */
  scopes: string[];
}

/** A secret shorter than 256 bits would be the weak link. */
const MIN_SECRET_BYTES = 32;

/** So each use of a host secret derives a key no other use shares. */
const STATE_KEY_INFO = 'theorem/oauth-state/v1';
const SECRET_KEY_INFO = 'theorem/sealed-secret/v1';

const IV_BYTES = 12;

/** A fresh salt per seal gives every seal its own key, so no key sees enough random nonces for one to repeat. */
const SALT_BYTES = 32;

/** Authenticated with the ciphertext, so a later scheme can be told apart and an old one is never guessed at. */
const ENVELOPE_VERSION = 'v1';

async function sealKey(
  secret: string,
  salt: Uint8Array<ArrayBuffer>,
  info: string,
  label: string,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const secretBytes = encoder.encode(secret);
  if (secretBytes.length < MIN_SECRET_BYTES) {
    throw new RangeError(
      `${label} must be at least ${MIN_SECRET_BYTES} bytes; got ${secretBytes.length}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const base = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt, info: encoder.encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

interface SealScheme {
  /** HKDF info: which use of the secret this is. */
  info: string;
  /** Names the secret in a too-short error. */
  label: string;
  /** Authenticated alongside the ciphertext; opening with different data fails. */
  associatedData: string;
}

/** `salt.iv.ciphertext`, base64url: AES-256-GCM under a key derived per seal. */
async function sealBytes(plaintext: string, secret: string, scheme: SealScheme): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await sealKey(secret, salt, scheme.info, scheme.label);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv,
      additionalData: new TextEncoder().encode(scheme.associatedData),
    },
    key,
    new TextEncoder().encode(plaintext),
  );
  return [toBase64Url(salt), toBase64Url(iv), toBase64Url(new Uint8Array(ciphertext))].join('.');
}

/** The plaintext `sealBytes` sealed, or null when the envelope does not open under this secret and data. */
async function openBytes(
  parts: readonly string[],
  secret: string,
  scheme: SealScheme,
): Promise<string | null> {
  const [saltB64, ivB64, ciphertextB64] = parts;
  if (saltB64 === undefined || ivB64 === undefined || ciphertextB64 === undefined) return null;
  const key = await sealKey(secret, fromBase64Url(saltB64), scheme.info, scheme.label);
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(ivB64),
        additionalData: new TextEncoder().encode(scheme.associatedData),
      },
      key,
      fromBase64Url(ciphertextB64),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

const STATE_SCHEME: SealScheme = {
  info: STATE_KEY_INFO,
  label: 'OAuth state secret', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  associatedData: ENVELOPE_VERSION,
};

/** Encrypted, not only signed: the state crosses the browser and the server, and the PKCE verifier must stay secret. */
export async function sealStatePayload(
  payload: SealedStatePayload,
  secret: string,
): Promise<string> {
  const envelope = await sealBytes(JSON.stringify(payload), secret, STATE_SCHEME);
  return [ENVELOPE_VERSION, envelope].join('.');
}

export async function unsealStatePayload(
  sealed: string,
  secret: string,
): Promise<SealedStatePayload> {
  const [version, ...parts] = sealed.split('.');
  if (version !== ENVELOPE_VERSION || parts.length !== 3) {
    throw new Error('Invalid sealed state format'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const plaintext = await openBytes(parts, secret, STATE_SCHEME);
  if (plaintext === null) {
    throw new Error(
      'OAuth state could not be opened: it was tampered with, corrupted, or sealed with another secret', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }

  const payload = JSON.parse(plaintext) as SealedStatePayload;
  if (!Array.isArray(payload.scopes)) {
    throw new Error('Invalid sealed state format'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (Date.now() > payload.expiresAt) {
    throw new Error('OAuth state has expired'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return payload;
}

function secretScheme(keyVersion: number, binding: readonly string[]): SealScheme {
  return {
    info: SECRET_KEY_INFO,
    label: 'Secret sealing key', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    associatedData: JSON.stringify([ENVELOPE_VERSION, keyVersion, binding]),
  };
}

function assertKeyVersion(keyVersion: number): void {
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 0) {
    throw new RangeError(`Key version must be a non-negative integer; got ${keyVersion}`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

export interface SealSecretInput {
  plaintext: string;
  /** The host's sealing key: at least 32 bytes, kept apart from where sealed values are stored. */
  key: string;
  /** What the sealed value belongs to, such as owner, slot and row. Opening needs the same list. */
  binding: readonly string[];
  /** Names `key`, so a rotated key still opens what an older one sealed. */
  keyVersion: number;
}

/**
 * Seals a stored credential. AES-256-GCM under a key derived per seal; the key
 * version and binding are authenticated, so a value copied to another owner,
 * slot or row does not open.
 */
export async function sealSecret(input: SealSecretInput): Promise<string> {
  assertKeyVersion(input.keyVersion);
  const scheme = secretScheme(input.keyVersion, input.binding);
  const envelope = await sealBytes(input.plaintext, input.key, scheme);
  return [ENVELOPE_VERSION, String(input.keyVersion), envelope].join('.');
}

export interface OpenSecretInput {
  sealed: string;
  /** Every key still in use, by version. */
  keys: Readonly<Record<number, string>>;
  /** The binding the value was sealed with. */
  binding: readonly string[];
}

/** Opens what `sealSecret` sealed; throws when the envelope, key version or binding does not match. */
export async function openSecret(input: OpenSecretInput): Promise<string> {
  const [version, keyVersionText, ...parts] = input.sealed.split('.');
  const keyVersion = Number(keyVersionText);
  if (version !== ENVELOPE_VERSION || parts.length !== 3 || !/^\d+$/.test(keyVersionText ?? '')) {
    throw new Error('Invalid sealed secret format'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const key = input.keys[keyVersion];
  if (key === undefined) {
    throw new Error(`No key for sealed secret key version ${keyVersion}`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const plaintext = await openBytes(parts, key, secretScheme(keyVersion, input.binding));
  if (plaintext === null) {
    throw new Error(
      'Sealed secret could not be opened: it was tampered with, bound to something else, or sealed with another key', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  return plaintext;
}
