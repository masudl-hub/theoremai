import {
  fromBase64Url,
  generateCodeVerifier,
  openSecret,
  type SealedStatePayload,
  sealSecret,
  sealStatePayload,
  toBase64Url,
  unsealStatePayload,
} from '../../src/kernel/auth/crypto.ts';
import { assertEquals, assertRejects, assertThrows } from '../../src/kernel/engine/assert.ts';

/** Names the case that failed; `assertEquals` takes only the two values. */
function check(actual: unknown, expected: unknown, label: string): void {
  assertEquals({ label, value: actual }, { label, value: expected });
}

const SECRET = 'a-host-secret-of-more-than-thirty-two-bytes';
const VERIFIER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

const PAYLOAD: SealedStatePayload = {
  codeVerifier: 'v'.repeat(43),
  expectedIssuer: 'https://auth.example.com',
  issRequired: true,
  tokenEndpoint: 'https://auth.example.com/token',
  resource: 'https://mcp.example.com',
  redirectUri: 'https://app.example.com/cb',
  expiresAt: 2_000,
  clientId: 'client',
  sessionBinding: 'binding',
  scopes: ['a'],
};

Deno.test('base64url swaps the two unsafe characters and strips only trailing padding', () => {
  check(toBase64Url(new Uint8Array([0xfb, 0xef, 0xff])), '--__', 'plus and slash');
  check(toBase64Url(new Uint8Array([0xff])), '_w', 'one byte, two pads');
  check(toBase64Url(new Uint8Array([0xff, 0xff])), '__8', 'two bytes, one pad');
  check(toBase64Url(new Uint8Array([])), '', 'empty');
  check(fromBase64Url('--__'), new Uint8Array([0xfb, 0xef, 0xff]), 'decodes plus and slash');
  check(fromBase64Url('_w'), new Uint8Array([0xff]), 'decodes without padding');
  check(fromBase64Url('__8'), new Uint8Array([0xff, 0xff]), 'decodes one pad short');
  check(
    fromBase64Url(toBase64Url(new Uint8Array([1, 2, 3, 4, 5]))),
    new Uint8Array([1, 2, 3, 4, 5]),
    'round trip',
  );
});

Deno.test('a string that is not base64url is refused with the reason', () => {
  assertThrows(() => fromBase64Url('!!!!'), Error, 'Invalid base64url encoding: ');
});

/** Hands `generateCodeVerifier` the bytes in order, in buffers of the size it asks for. */
function withRandomBytes<T>(bytes: number[], body: (asked: number[]) => T): T {
  const original = crypto.getRandomValues.bind(crypto);
  const asked: number[] = [];
  let at = 0;
  crypto.getRandomValues = ((buffer: Uint8Array) => {
    asked.push(buffer.length);
    for (let i = 0; i < buffer.length; i++) buffer[i] = bytes[at++ % bytes.length] ?? 0;
    return buffer;
  }) as typeof crypto.getRandomValues;
  try {
    return body(asked);
  } finally {
    crypto.getRandomValues = original;
  }
}

Deno.test('a code verifier is 43 to 128 characters of the unreserved set', () => {
  check(generateCodeVerifier().length, 64, 'default length');
  for (const length of [43, 44, 127, 128]) {
    const verifier = generateCodeVerifier(length);
    check(verifier.length, length, `length ${length}`);
    check(
      [...verifier].every((char) => VERIFIER_CHARS.includes(char)),
      true,
      `characters at ${length}`,
    );
  }
  for (const length of [42, 129, 0, -1]) {
    assertThrows(
      () => generateCodeVerifier(length),
      RangeError,
      `Invalid PKCE code_verifier length: ${length}.`,
    );
  }
});

Deno.test('a code verifier draws without modulo bias: bytes at or above 198 are discarded', () => {
  withRandomBytes([255, 198, 197], (asked) => {
    check(generateCodeVerifier(43), '~'.repeat(43), 'only 197 is taken (197 % 66 = 65)');
    check(asked[0], 86, 'the first buffer is twice the length');
  });
});

Deno.test('a code verifier maps each accepted byte to its character, modulo the set size', () => {
  withRandomBytes([0, 1, 25, 26, 65, 66, 67, 197], () => {
    const verifier = generateCodeVerifier(43);
    check(verifier.slice(0, 8), 'ABZa~AB~', 'first eight');
    check(verifier.length, 43, 'length');
  });
});

Deno.test('a code verifier stops at its length even when the buffer holds more usable bytes', () => {
  withRandomBytes([1], () => {
    check(generateCodeVerifier(43), 'B'.repeat(43), 'exactly the length asked for');
  });
});

Deno.test('a sealing secret under 32 bytes is refused, and the error names which secret', async () => {
  const short = 'x'.repeat(31);
  await assertRejects(
    () => sealStatePayload(PAYLOAD, short),
    RangeError,
    'OAuth state secret must be at least 32 bytes; got 31',
  );
  await assertRejects(
    () => sealSecret({ plaintext: 'p', key: short, binding: [], keyVersion: 1 }),
    RangeError,
    'Secret sealing key must be at least 32 bytes; got 31',
  );
  const exact = 'x'.repeat(32);
  const sealed = await sealSecret({ plaintext: 'p', key: exact, binding: [], keyVersion: 1 });
  check(await openSecret({ sealed, keys: { 1: exact }, binding: [] }), 'p', '32 bytes is enough');
});

/** The same HKDF and AES-GCM a verifier outside the module would run, from the documented labels. */
async function openIndependently(
  envelope: string,
  secret: string,
  info: string,
  associatedData: string,
): Promise<string> {
  const [salt, iv, ciphertext] = envelope.split('.');
  const encoder = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: fromBase64Url(salt ?? ''), info: encoder.encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64Url(iv ?? ''),
      additionalData: encoder.encode(associatedData),
    },
    key,
    fromBase64Url(ciphertext ?? ''),
  );
  return new TextDecoder().decode(plain);
}

Deno.test('a sealed state is AES-GCM under HKDF of the secret with its documented labels', async () => {
  const sealed = await sealStatePayload(PAYLOAD, SECRET);
  const [version, ...rest] = sealed.split('.');
  check(version, 'v1', 'version');
  check(rest.length, 3, 'salt.iv.ciphertext');
  const plain = await openIndependently(rest.join('.'), SECRET, 'theorem/oauth-state/v1', 'v1');
  check(JSON.parse(plain), PAYLOAD, 'payload');
});

Deno.test('a sealed secret is AES-GCM under HKDF with its labels, key version and binding', async () => {
  const sealed = await sealSecret({
    plaintext: 'hunter2',
    key: SECRET,
    binding: ['owner', 'slot'],
    keyVersion: 7,
  });
  const [version, keyVersion, ...rest] = sealed.split('.');
  check([version, keyVersion, rest.length], ['v1', '7', 3], 'envelope');
  const plain = await openIndependently(
    rest.join('.'),
    SECRET,
    'theorem/sealed-secret/v1',
    JSON.stringify(['v1', 7, ['owner', 'slot']]),
  );
  check(plain, 'hunter2', 'plaintext');
});

Deno.test('a sealed state of the wrong shape, or with the wrong number of parts, is refused by name', async () => {
  const sealed = await sealStatePayload(PAYLOAD, SECRET);
  const [version, salt, iv, ciphertext] = sealed.split('.');
  for (const [label, bad] of [
    ['too few parts', `${version}.${salt}.${iv}`],
    ['too many parts', `${sealed}.extra`],
    ['another version', `v2.${salt}.${iv}.${ciphertext}`],
    ['empty', ''],
  ] as const) {
    check(
      await unsealStatePayload(bad, SECRET).then(
        () => 'opened',
        (err: Error) => `${label}: ${err.message}`,
      ),
      `${label}: Invalid sealed state format`,
      label,
    );
  }
  const noScopes = { ...PAYLOAD } as Partial<SealedStatePayload>;
  delete noScopes.scopes;
  await assertRejects(
    async () =>
      unsealStatePayload(await sealStatePayload(noScopes as SealedStatePayload, SECRET), SECRET),
    Error,
    'Invalid sealed state format',
  );
  await assertRejects(
    async () =>
      unsealStatePayload(
        await sealStatePayload({ ...PAYLOAD, scopes: 'a' as unknown as string[] }, SECRET),
        SECRET,
      ),
    Error,
    'Invalid sealed state format',
  );
});

Deno.test('a sealed state is good through its expiry millisecond and refused after it', async () => {
  const realNow = Date.now;
  try {
    const sealed = await sealStatePayload(PAYLOAD, SECRET);
    Date.now = () => 2_000;
    check((await unsealStatePayload(sealed, SECRET)).expiresAt, 2_000, 'at expiry');
    Date.now = () => 2_001;
    await assertRejects(() => unsealStatePayload(sealed, SECRET), Error, 'OAuth state has expired');
  } finally {
    Date.now = realNow;
  }
});

Deno.test('a key version is a non-negative safe integer', async () => {
  const seal = (keyVersion: number) =>
    sealSecret({ plaintext: 'p', key: SECRET, binding: [], keyVersion });
  for (const keyVersion of [0, 1, 10, Number.MAX_SAFE_INTEGER]) {
    const sealed = await seal(keyVersion);
    check(
      await openSecret({ sealed, keys: { [keyVersion]: SECRET }, binding: [] }),
      'p',
      `version ${keyVersion}`,
    );
  }
  for (const keyVersion of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    await assertRejects(
      () => seal(keyVersion),
      RangeError,
      `Key version must be a non-negative integer; got ${keyVersion}`,
    );
  }
});

Deno.test('an envelope with a malformed key version is a format error, not a missing key', async () => {
  const sealed = await sealSecret({ plaintext: 'p', key: SECRET, binding: [], keyVersion: 1 });
  const [version, , ...rest] = sealed.split('.');
  for (const text of ['1x', '-1', '', '1.5', ' 1']) {
    const bad = [version, text, ...rest].join('.');
    await assertRejects(
      () => openSecret({ sealed: bad, keys: { 1: SECRET }, binding: [] }),
      Error,
      'Invalid sealed secret format',
    );
  }
  await assertRejects(
    () =>
      openSecret({ sealed: [version, '2', ...rest].join('.'), keys: { 1: SECRET }, binding: [] }),
    Error,
    'No key for sealed secret key version 2',
  );
});
