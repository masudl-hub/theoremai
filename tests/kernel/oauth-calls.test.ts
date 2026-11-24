import { TheoremError } from '../../src/guardrails/error.ts';
import { memoryCredentialSource } from '../../src/kernel/auth/credential-source.ts';
import { sealStatePayload } from '../../src/kernel/auth/crypto.ts';
import {
  callsOfOAuthError,
  exchangeOAuthPkce,
  OAuthTokenError,
  refreshOAuthToken,
  revokeOAuthToken,
} from '../../src/kernel/auth/oauth.ts';
import type { OAuth2Credential, OAuthCall } from '../../src/kernel/auth/types.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { sealedCredentialHost } from '../../src/kernel/tools/mod.ts';

const ISSUER = 'https://auth.example.com';
const TOKEN = 'https://auth.example.com/oauth/token';
const REVOKE = 'https://auth.example.com/oauth/revoke';
const AS_URL = `${ISSUER}/.well-known/oauth-authorization-server`;
const RESOURCE = 'https://api.example.com/mcp';
const SECRET = 'a-host-secret-of-more-than-thirty-two-bytes';
const SESSION = 'session-of-the-user-who-began-the-flow';
const REDIRECT = 'https://my-host.com/oauth/callback';
const PUBLIC_HOST = () => Promise.resolve(['93.184.216.34']);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const TOKENS = { access_token: 'new', token_type: 'Bearer', expires_in: 3600 };

const answered = (method: string, endpoint: string, status: number): OAuthCall => ({
  method,
  endpoint,
  outcome: 'answered',
  status,
});

/** Answers each request in turn; a function answer throws, as a network failure does. */
function answering(...answers: (Response | Error)[]): typeof fetch {
  return () => {
    const next = answers.shift();
    if (next === undefined) return Promise.reject(new Error('unexpected request'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
}

async function exchange(fetchFn: typeof fetch, timeoutMs?: number) {
  const state = await sealStatePayload(
    {
      codeVerifier: 'v'.repeat(43),
      expectedIssuer: ISSUER,
      issRequired: false,
      tokenEndpoint: TOKEN,
      resource: RESOURCE,
      redirectUri: REDIRECT,
      expiresAt: Date.now() + 60_000,
      clientId: 'client',
      sessionBinding: await digestOf(SESSION),
      scopes: [],
    },
    SECRET,
  );
  return exchangeOAuthPkce({
    code: 'secret-code',
    state,
    redirectUri: REDIRECT,
    signingSecret: SECRET,
    sessionBinding: SESSION,
    resolveHost: PUBLIC_HOST,
    fetchFn,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

async function digestOf(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

const refresh = (fetchFn: typeof fetch) =>
  refreshOAuthToken({
    issuer: ISSUER,
    resource: RESOURCE,
    tokenEndpoint: `${TOKEN}?tenant=secret`,
    clientId: 'client',
    refreshToken: 'rt',
    resolveHost: PUBLIC_HOST,
    fetchFn,
  });

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('it resolved');
}

Deno.test('an exchange reports the token request and its status', async () => {
  const result = await exchange(answering(json(TOKENS)));
  assertEquals(result.calls, [answered('POST', TOKEN, 200)]);
});

Deno.test('a refresh reports its call without the query', async () => {
  const result = await refresh(answering(json(TOKENS)));
  assertEquals(result.calls, [answered('POST', TOKEN, 200)]);
});

Deno.test('a refused exchange and a refused refresh carry the refused call', async () => {
  const exchanged = await caught(() => exchange(answering(json({ error: 'invalid_grant' }, 400))));
  assertEquals(exchanged instanceof OAuthTokenError ? exchanged.calls : exchanged, [
    answered('POST', TOKEN, 400),
  ]);
  const refreshed = await caught(() => refresh(answering(json({ error: 'busy' }, 503))));
  assertEquals(refreshed instanceof OAuthTokenError ? refreshed.calls : refreshed, [
    answered('POST', TOKEN, 503),
  ]);
});

Deno.test('a request that got no answer is its own case, network or timeout', async () => {
  const refused = await caught(() => refresh(answering(new TypeError('connection reset'))));
  assertEquals(refused instanceof TheoremError ? refused.kind : refused, 'network');
  assertEquals(callsOfOAuthError(refused), [
    { method: 'POST', endpoint: TOKEN, outcome: 'no_answer', reason: 'network' },
  ]);
  const slow: typeof fetch = (_input, init) =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  const timedOut = await caught(() => exchange(slow, 10));
  assertEquals(callsOfOAuthError(timedOut), [
    { method: 'POST', endpoint: TOKEN, outcome: 'no_answer', reason: 'timeout' },
  ]);
});

Deno.test('an answer that is not a token response still reports its status', async () => {
  const bad = await caught(() => refresh(answering(json({ nothing: true }))));
  assertEquals(callsOfOAuthError(bad), [answered('POST', TOKEN, 200)]);
});

Deno.test('a request the network policy refuses was never sent, so it is not a call', async () => {
  const sent: string[] = [];
  const err = await caught(() =>
    refreshOAuthToken({
      issuer: ISSUER,
      resource: RESOURCE,
      tokenEndpoint: TOKEN,
      clientId: 'client',
      refreshToken: 'rt',
      resolveHost: () => Promise.resolve(['10.0.0.1']),
      fetchFn: (input) => {
        sent.push(String(input));
        return Promise.resolve(json(TOKENS));
      },
    }),
  );
  assertEquals({ sent, calls: callsOfOAuthError(err) }, { sent: [], calls: [] });
});

const SIGNED_IN = { issuer: ISSUER, clientId: 'client', accessToken: 'at', refreshToken: 'rt' };

Deno.test('a revocation reports both calls when the server wants the access token too', async () => {
  const result = await revokeOAuthToken({
    credential: SIGNED_IN,
    revocationEndpoint: REVOKE,
    resolveHost: PUBLIC_HOST,
    fetchFn: answering(
      json({ error: 'unsupported_token_type' }, 400),
      new Response('', { status: 200 }),
    ),
  });
  assertEquals(result, {
    revocation: 'revoked',
    calls: [answered('POST', REVOKE, 400), answered('POST', REVOKE, 200)],
  });
});

Deno.test('a revocation that looked the endpoint up reports the lookup first', async () => {
  const metadata = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: TOKEN,
    revocation_endpoint: REVOKE,
  };
  const found = await revokeOAuthToken({
    credential: SIGNED_IN,
    resolveHost: PUBLIC_HOST,
    fetchFn: answering(json(metadata), new Response('', { status: 200 })),
  });
  assertEquals(found.calls, [answered('GET', AS_URL, 200), answered('POST', REVOKE, 200)]);
  const { revocation_endpoint: _, ...without } = metadata;
  const none = await revokeOAuthToken({
    credential: SIGNED_IN,
    resolveHost: PUBLIC_HOST,
    fetchFn: answering(json(without)),
  });
  assertEquals(none, { revocation: 'unsupported', calls: [answered('GET', AS_URL, 200)] });
});

Deno.test('a revocation names every metadata address that did not answer', async () => {
  const err = await caught(() =>
    revokeOAuthToken({
      credential: SIGNED_IN,
      resolveHost: PUBLIC_HOST,
      fetchFn: answering(new Response('', { status: 404 }), new Response('', { status: 500 })),
    }),
  );
  assertEquals(callsOfOAuthError(err), [
    answered('GET', AS_URL, 404),
    answered('GET', `${ISSUER}/.well-known/openid-configuration`, 500),
  ]);
});

Deno.test('a revocation refusal carries the calls up to the refused one', async () => {
  const err = await caught(() =>
    revokeOAuthToken({
      credential: SIGNED_IN,
      revocationEndpoint: REVOKE,
      resolveHost: PUBLIC_HOST,
      fetchFn: answering(json({ error: 'unsupported_token_type' }, 400), json({ error: 'x' }, 503)),
    }),
  );
  assertEquals(err instanceof OAuthTokenError ? err.calls : err, [
    answered('POST', REVOKE, 400),
    answered('POST', REVOKE, 503),
  ]);
});

const EXPIRED: OAuth2Credential = {
  type: 'oauth2',
  issuer: ISSUER,
  resource: RESOURCE,
  accessToken: 'old',
  refreshToken: 'old-refresh',
  tokenEndpoint: TOKEN,
  clientId: 'client',
  expiresAt: Date.now() - 1000,
};

const hostOver = (fetchFn: typeof fetch, credential: OAuth2Credential = EXPIRED) =>
  sealedCredentialHost({
    source: memoryCredentialSource({ slot: credential }),
    slots: { slot: { resource: RESOURCE } },
    resolveHost: PUBLIC_HOST,
    fetchFn,
  });

Deno.test('prepare reports a renewal made by this call', async () => {
  const ready = await hostOver(answering(json(TOKENS))).prepare('slot');
  assertEquals(ready.state === 'ready' ? ready.renewal : ready.state, {
    state: 'renewed',
    madeBy: 'this_call',
    calls: [answered('POST', TOKEN, 200)],
  });
});

Deno.test('prepare reports a refused, failed or unanswered renewal with its kind and calls', async () => {
  const refused = await hostOver(answering(json({ error: 'invalid_grant' }, 400))).prepare('slot');
  assertEquals(refused.state === 'unusable' ? refused.renewal : refused.state, {
    state: 'failed',
    madeBy: 'this_call',
    kind: 'auth',
    calls: [answered('POST', TOKEN, 400)],
  });
  const busy = await hostOver(answering(json({}, 503))).prepare('slot');
  assertEquals(busy.state === 'unusable' ? busy.renewal : busy.state, {
    state: 'failed',
    madeBy: 'this_call',
    kind: 'busy',
    calls: [answered('POST', TOKEN, 503)],
  });
  const silent = await hostOver(answering(new TypeError('down'))).prepare('slot');
  assertEquals(silent.state === 'unusable' ? silent.renewal : silent.state, {
    state: 'failed',
    madeBy: 'this_call',
    kind: 'network',
    calls: [{ method: 'POST', endpoint: TOKEN, outcome: 'no_answer', reason: 'network' }],
  });
});

Deno.test('prepare reports no renewal when none was needed or possible', async () => {
  const fresh = await hostOver(answering(), {
    ...EXPIRED,
    expiresAt: Date.now() + 3_600_000,
  }).prepare('slot');
  assertEquals(fresh.state === 'ready' ? fresh.renewal : fresh.state, { state: 'none' });
  const { refreshToken: _, ...noRefresh } = EXPIRED;
  const expired = await hostOver(answering(), noRefresh).prepare('slot');
  assertEquals(expired.state === 'unusable' ? expired.renewal : expired.state, { state: 'none' });
});

Deno.test('callers that share one renewal say which of them made it', async () => {
  let requests = 0;
  const fetchFn: typeof fetch = async () => {
    requests++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return json(TOKENS);
  };
  const host = hostOver(fetchFn);
  const [first, second] = await Promise.all([host.prepare('slot'), host.prepare('slot')]);
  const renewals = [first, second].map((ready) =>
    ready.state === 'ready' ? ready.renewal : ready.state,
  );
  assertEquals(requests, 1);
  assertEquals(renewals, [
    { state: 'renewed', madeBy: 'this_call', calls: [answered('POST', TOKEN, 200)] },
    { state: 'renewed', madeBy: 'another_call', calls: [answered('POST', TOKEN, 200)] },
  ]);
});
