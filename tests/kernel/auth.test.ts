import {
  computeCodeChallenge,
  fromBase64Url,
  generateCodeVerifier,
  sealStatePayload,
  unsealStatePayload,
} from '../../src/kernel/auth/crypto.ts';
import {
  createOAuthPkceFlow,
  discoverAuthServerMetadata,
  discoverResourceMetadata,
  exchangeOAuthPkce,
  refreshOAuthToken,
  tokenAudienceCovers,
  validateIssuer,
} from '../../src/kernel/auth/oauth.ts';
import { credentialFromTypedSecret } from '../../src/kernel/auth/typed-secret.ts';
import { assertEquals, assertRejects, assertThrows } from '../../src/kernel/engine/assert.ts';

const SECRET = 'test-state-secret-0123456789abcdef';
const SESSION = 'session-id-of-the-user-who-began-the-flow';
const ISSUER = 'https://auth.example.com';
const RESOURCE = 'https://mcp.example.com';
const REDIRECT = 'https://my-host.com/oauth/callback';
const TOKEN_ENDPOINT = 'https://auth.example.com/oauth/token';

const PRE_RESOLVED = {
  issuer: ISSUER,
  authorizationEndpoint: 'https://auth.example.com/oauth/authorize',
  tokenEndpoint: TOKEN_ENDPOINT,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fetch that answers by URL and records every request it saw. */
function routes(table: Record<string, () => Response>) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const url = String(input);
    seen.push({ url, init });
    const route = table[url];
    return Promise.resolve(route ? route() : new Response('not found', { status: 404 }));
  };
  return { fetchFn, seen };
}

const AS_METADATA = {
  issuer: ISSUER,
  authorization_endpoint: 'https://auth.example.com/oauth/authorize',
  token_endpoint: TOKEN_ENDPOINT,
  code_challenge_methods_supported: ['S256'],
  authorization_response_iss_parameter_supported: true,
};

const BEARER = { access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 3600 };

function statePayload(overrides: Partial<Parameters<typeof sealStatePayload>[0]> = {}) {
  return {
    codeVerifier: 'test-code-verifier-value',
    expectedIssuer: ISSUER,
    issRequired: false,
    tokenEndpoint: TOKEN_ENDPOINT,
    resource: RESOURCE,
    redirectUri: REDIRECT,
    expiresAt: Date.now() + 60000,
    clientId: 'test-client-123',
    sessionBinding: 'digest-of-the-session-binding',
    ...overrides,
  };
}

Deno.test('PKCE code challenge matches RFC 7636 Appendix B test vector', async () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assertEquals(await computeCodeChallenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

Deno.test('generateCodeVerifier creates valid length and characters', () => {
  const v = generateCodeVerifier(64);
  assertEquals(v.length, 64);
  assertEquals(/^[A-Za-z0-9\-._~]+$/.test(v), true);
  assertThrows(() => generateCodeVerifier(42), RangeError, 'RFC 7636 Section 4.1');
  assertThrows(() => generateCodeVerifier(129), RangeError, 'RFC 7636 Section 4.1');
});

Deno.test('the sealed state round-trips and never shows the verifier in the clear', async () => {
  const payload = statePayload();
  const sealed = await sealStatePayload(payload, SECRET);
  const readable = sealed
    .split('.')
    .map((part) => new TextDecoder().decode(fromBase64Url(part)))
    .join('');
  assertEquals(readable.includes(payload.codeVerifier), false);
  assertEquals(await unsealStatePayload(sealed, SECRET), payload);
});

Deno.test('the sealed state refuses tampering, another secret, a short secret, and expiry', async () => {
  const sealed = await sealStatePayload(statePayload(), SECRET);
  const parts = sealed.split('.');
  const flip = (at: number) =>
    parts
      .map((part, i) => (i === at ? `${part.startsWith('A') ? 'B' : 'A'}${part.slice(1)}` : part))
      .join('.');
  for (const at of [1, 2, 3]) {
    await assertRejects(() => unsealStatePayload(flip(at), SECRET), Error, 'could not be opened');
  }
  await assertRejects(
    () => unsealStatePayload(['v0', ...parts.slice(1)].join('.'), SECRET),
    Error,
    'Invalid sealed state format',
  );
  await assertRejects(
    () => unsealStatePayload(parts.slice(2).join('.'), SECRET),
    Error,
    'Invalid sealed state format',
  );
  await assertRejects(
    () => unsealStatePayload(sealed, 'another-state-secret-0123456789abcdef'),
    Error,
    'could not be opened',
  );
  await assertRejects(() => unsealStatePayload('not-a-valid-envelope', SECRET), Error);
  await assertRejects(() => unsealStatePayload('part1.part2.part3', SECRET), Error);
  await assertRejects(() => sealStatePayload(statePayload(), 'short'), RangeError, '32 bytes');

  const expired = await sealStatePayload(statePayload({ expiresAt: Date.now() - 1000 }), SECRET);
  await assertRejects(() => unsealStatePayload(expired, SECRET), Error, 'OAuth state has expired');
});

Deno.test('validateIssuer is byte-exact and requires iss when the server sends it', () => {
  validateIssuer(ISSUER, ISSUER, true);
  validateIssuer(ISSUER, undefined, false);
  assertThrows(() => validateIssuer(ISSUER, undefined, true), Error, 'the response has none');
  assertThrows(
    () => validateIssuer(ISSUER, 'https://attacker.example.com', false),
    Error,
    'RFC 9207 Issuer mismatch detected',
  );
  assertThrows(() => validateIssuer(ISSUER, `${ISSUER}/`, false), Error, 'Issuer mismatch');
  assertThrows(() => validateIssuer(ISSUER, '', false), Error, 'Issuer mismatch');
});

Deno.test('createOAuthPkceFlow builds a compliant authorization URL from host endpoints', async () => {
  const flow = await createOAuthPkceFlow({
    resourceServerUrl: RESOURCE,
    clientId: 'my-client-id',
    redirectUri: REDIRECT,
    scopes: ['read', 'write'],
    signingSecret: SECRET,
    sessionBinding: SESSION,
    preResolved: PRE_RESOLVED,
  });
  const url = new URL(flow.authorizationUrl);
  assertEquals(url.origin, ISSUER);
  assertEquals(url.pathname, '/oauth/authorize');
  assertEquals(url.searchParams.get('response_type'), 'code');
  assertEquals(url.searchParams.get('client_id'), 'my-client-id');
  assertEquals(url.searchParams.get('code_challenge_method'), 'S256');
  assertEquals(url.searchParams.get('code_challenge'), flow.codeChallenge);
  assertEquals(url.searchParams.get('resource'), RESOURCE);
  assertEquals(url.searchParams.get('scope'), 'read write');
  assertEquals('codeVerifier' in flow, false);
  assertEquals(flow.authorizationUrl.includes(SESSION), false);

  await assertRejects(
    () =>
      createOAuthPkceFlow({
        resourceServerUrl: RESOURCE,
        clientId: 'c',
        redirectUri: REDIRECT,
        signingSecret: SECRET,
        sessionBinding: SESSION,
        preResolved: {
          ...PRE_RESOLVED,
          authorizationEndpoint: 'http://auth.example.com/authorize',
        },
      }),
    Error,
    'must be an https URL',
  );
});

Deno.test('discovery follows the resource to its server, then seals endpoint and iss rule', async () => {
  const { fetchFn, seen } = routes({
    'https://api.example.com/.well-known/oauth-protected-resource/mcp': () =>
      json({ resource: 'https://api.example.com/mcp', authorization_servers: [ISSUER] }),
    'https://auth.example.com/.well-known/oauth-authorization-server': () => json(AS_METADATA),
    [TOKEN_ENDPOINT]: () => json(BEARER),
  });
  const flow = await createOAuthPkceFlow({
    resourceServerUrl: 'https://api.example.com/mcp',
    clientId: 'c',
    redirectUri: REDIRECT,
    signingSecret: SECRET,
    sessionBinding: SESSION,
    fetchFn,
  });
  assertEquals(flow.issuer, ISSUER);
  assertEquals(flow.resource, 'https://api.example.com/mcp');
  assertEquals(
    seen.every(({ init }) => init?.redirect === 'manual'),
    true,
  );

  // The server advertised iss, so a response without it is a mix-up attempt.
  await assertRejects(
    () =>
      exchangeOAuthPkce({
        code: 'code',
        state: flow.state,
        redirectUri: REDIRECT,
        signingSecret: SECRET,
        sessionBinding: SESSION,
        fetchFn,
      }),
    Error,
    'the response has none',
  );
  const result = await exchangeOAuthPkce({
    code: 'code',
    state: flow.state,
    iss: ISSUER,
    redirectUri: REDIRECT,
    signingSecret: SECRET,
    sessionBinding: SESSION,
    fetchFn,
  });
  assertEquals(result.credential.tokenEndpoint, TOKEN_ENDPOINT);
  assertEquals(seen.at(-1)?.url, TOKEN_ENDPOINT);
});

Deno.test('discovery refuses metadata for another resource or issuer, and servers without S256', async () => {
  const otherResource = routes({
    'https://mcp.example.com/.well-known/oauth-protected-resource': () =>
      json({ resource: 'https://evil.example.com', authorization_servers: [ISSUER] }),
  });
  await assertRejects(
    () => discoverResourceMetadata(RESOURCE, { fetchFn: otherResource.fetchFn }),
    Error,
    'not "https://mcp.example.com"',
  );

  const otherIssuer = routes({
    'https://auth.example.com/.well-known/oauth-authorization-server': () =>
      json({ ...AS_METADATA, issuer: 'https://evil.example.com' }),
    'https://auth.example.com/.well-known/openid-configuration': () => json(AS_METADATA),
  });
  await assertRejects(
    () => discoverAuthServerMetadata(ISSUER, { fetchFn: otherIssuer.fetchFn }),
    Error,
    'names issuer "https://evil.example.com"',
  );
  assertEquals(otherIssuer.seen.length, 1);

  const noPkce = routes({
    'https://auth.example.com/.well-known/oauth-authorization-server': () =>
      json({ ...AS_METADATA, code_challenge_methods_supported: ['plain'] }),
  });
  await assertRejects(
    () =>
      createOAuthPkceFlow({
        resourceServerUrl: ISSUER,
        clientId: 'c',
        redirectUri: REDIRECT,
        signingSecret: SECRET,
        sessionBinding: SESSION,
        fetchFn: noPkce.fetchFn,
      }),
    Error,
    'does not advertise S256',
  );
});

Deno.test('a resource without metadata is its own authorization server', async () => {
  const { fetchFn, seen } = routes({
    'https://auth.example.com/.well-known/oauth-authorization-server': () => json(AS_METADATA),
  });
  const flow = await createOAuthPkceFlow({
    resourceServerUrl: ISSUER,
    clientId: 'c',
    redirectUri: REDIRECT,
    signingSecret: SECRET,
    sessionBinding: SESSION,
    fetchFn,
  });
  assertEquals(flow.issuer, ISSUER);
  assertEquals(
    seen.map(({ url }) => url),
    [
      'https://auth.example.com/.well-known/oauth-protected-resource',
      'https://auth.example.com/.well-known/oauth-authorization-server',
    ],
  );
});

Deno.test('discoverAuthServerMetadata tries RFC 8414, then OIDC inserted, then OIDC appended', async () => {
  const issuer = 'https://auth.example.com/tenant';
  const { fetchFn, seen } = routes({
    'https://auth.example.com/tenant/.well-known/openid-configuration': () =>
      json({ ...AS_METADATA, issuer }),
  });
  const meta = await discoverAuthServerMetadata(issuer, { fetchFn });
  assertEquals(meta.issuer, issuer);
  assertEquals(meta.code_challenge_methods_supported, ['S256']);
  assertEquals(meta.authorization_response_iss_parameter_supported, true);
  assertEquals(
    seen.map(({ url }) => url),
    [
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant',
      'https://auth.example.com/.well-known/openid-configuration/tenant',
      'https://auth.example.com/tenant/.well-known/openid-configuration',
    ],
  );
});

Deno.test('discoverAuthServerMetadata refuses incomplete metadata and surfaces network failure', async () => {
  const incomplete = routes({
    'https://auth.example.com/.well-known/oauth-authorization-server': () =>
      json({ issuer: ISSUER }),
  });
  await assertRejects(
    () => discoverAuthServerMetadata(ISSUER, { fetchFn: incomplete.fetchFn }),
    Error,
    'authorization_endpoint is missing',
  );
  const exploding: typeof fetch = () => Promise.reject(new TypeError('network down'));
  await assertRejects(
    () => discoverAuthServerMetadata(ISSUER, { fetchFn: exploding }),
    TypeError,
    'network down',
  );
  const nothing = routes({});
  await assertRejects(
    () => discoverAuthServerMetadata(ISSUER, { fetchFn: nothing.fetchFn }),
    Error,
    'Failed to discover authorization server metadata',
  );
});

Deno.test('exchangeOAuthPkce posts to the sealed endpoint and checks redirect_uri', async () => {
  const flow = await createOAuthPkceFlow({
    resourceServerUrl: RESOURCE,
    clientId: 'my-client-id',
    redirectUri: REDIRECT,
    signingSecret: SECRET,
    sessionBinding: SESSION,
    preResolved: PRE_RESOLVED,
  });
  const { fetchFn, seen } = routes({
    [TOKEN_ENDPOINT]: () => json({ ...BEARER, refresh_token: 'mock-refresh-token' }),
  });
  const result = await exchangeOAuthPkce({
    code: 'mock-auth-code-123',
    state: flow.state,
    iss: ISSUER,
    redirectUri: REDIRECT,
    signingSecret: SECRET,
    sessionBinding: SESSION,
    fetchFn,
  });
  assertEquals(result.credential.accessToken, 'mock-access-token');
  assertEquals(result.credential.refreshToken, 'mock-refresh-token');
  assertEquals(result.credential.issuer, ISSUER);
  assertEquals(result.credential.resource, RESOURCE);
  const body = new URLSearchParams(String(seen[0]?.init?.body));
  assertEquals(body.get('grant_type'), 'authorization_code');
  assertEquals(body.get('code'), 'mock-auth-code-123');
  assertEquals(await computeCodeChallenge(body.get('code_verifier') ?? ''), flow.codeChallenge);
  assertEquals(body.get('resource'), RESOURCE);

  await assertRejects(
    () =>
      exchangeOAuthPkce({
        code: 'mock-code',
        state: flow.state,
        redirectUri: 'https://attacker.com/evil',
        signingSecret: SECRET,
        sessionBinding: SESSION,
        fetchFn,
      }),
    Error,
    'Redirect URI mismatch',
  );
});

Deno.test('only the session that began the flow can finish it (login CSRF)', async () => {
  const flow = await createOAuthPkceFlow({
    resourceServerUrl: RESOURCE,
    clientId: 'my-client-id',
    redirectUri: REDIRECT,
    signingSecret: SECRET,
    sessionBinding: SESSION,
    preResolved: PRE_RESOLVED,
  });
  const readable = flow.state
    .split('.')
    .map((part) => new TextDecoder().decode(fromBase64Url(part)))
    .join('');
  assertEquals(readable.includes(SESSION), false);
  const { fetchFn, seen } = routes({ [TOKEN_ENDPOINT]: () => json(BEARER) });
  const exchange = (sessionBinding: string) =>
    exchangeOAuthPkce({
      code: 'attacker-code',
      state: flow.state,
      redirectUri: REDIRECT,
      signingSecret: SECRET,
      sessionBinding,
      fetchFn,
    });
  await assertRejects(() => exchange('victim-session-id'), Error, 'belongs to another session');
  await assertRejects(() => exchange(''), Error, 'non-empty');
  assertEquals(seen.length, 0);
  await exchange(SESSION);
  assertEquals(seen.length, 1);
  await assertRejects(
    () =>
      createOAuthPkceFlow({
        resourceServerUrl: RESOURCE,
        clientId: 'c',
        redirectUri: REDIRECT,
        signingSecret: SECRET,
        sessionBinding: '',
        preResolved: PRE_RESOLVED,
      }),
    Error,
    'non-empty',
  );
});

Deno.test('token responses must be bearer tokens, and errors repeat only the RFC 6749 fields', async () => {
  const refresh = (fetchFn: typeof fetch) =>
    refreshOAuthToken({
      refreshToken: 'old-refresh-token',
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      issuer: ISSUER,
      resource: RESOURCE,
      fetchFn,
    });
  await assertRejects(
    () => refresh(routes({ [TOKEN_ENDPOINT]: () => json({ access_token: 'x' }) }).fetchFn),
    Error,
    'not Bearer',
  );
  await assertRejects(
    () => refresh(routes({ [TOKEN_ENDPOINT]: () => json({ token_type: 'Bearer' }) }).fetchFn),
    Error,
    'has no access_token',
  );
  await assertRejects(
    () =>
      refresh(
        routes({
          [TOKEN_ENDPOINT]: () =>
            json({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, 400),
        }).fetchFn,
      ),
    Error,
    'Token refresh failed at https://auth.example.com/oauth/token (HTTP 400): invalid_grant (Refresh token revoked)',
  );
  const html = routes({
    [TOKEN_ENDPOINT]: () => new Response('<html>echo old-refresh-token</html>', { status: 500 }),
  });
  const message = await refresh(html.fetchFn).then(
    () => '',
    (err: Error) => err.message,
  );
  assertEquals(message, 'Token refresh failed at https://auth.example.com/oauth/token (HTTP 500)');
});

Deno.test('refreshOAuthToken keeps the refresh token the server did not rotate', async () => {
  const { fetchFn, seen } = routes({ [TOKEN_ENDPOINT]: () => json(BEARER) });
  const result = await refreshOAuthToken({
    refreshToken: 'old-refresh-token',
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: 'my-client',
    issuer: ISSUER,
    resource: RESOURCE,
    fetchFn,
  });
  assertEquals(result.credential.accessToken, 'mock-access-token');
  assertEquals(result.credential.refreshToken, 'old-refresh-token');
  const body = new URLSearchParams(String(seen[0]?.init?.body));
  assertEquals(body.get('grant_type'), 'refresh_token');
  assertEquals(body.get('refresh_token'), 'old-refresh-token');
});

Deno.test('token requests go only to public https endpoints and never follow a redirect', async () => {
  const { fetchFn, seen } = routes({
    [TOKEN_ENDPOINT]: () =>
      new Response(null, { status: 307, headers: { Location: 'https://evil.example.com/t' } }),
  });
  const refresh = (tokenEndpoint: string) =>
    refreshOAuthToken({
      refreshToken: 'old-refresh-token',
      tokenEndpoint,
      clientId: 'my-client',
      issuer: ISSUER,
      resource: RESOURCE,
      fetchFn,
    });
  await assertRejects(() => refresh(TOKEN_ENDPOINT), Error, '(HTTP 307)');
  assertEquals(
    seen.map(({ url }) => url),
    [TOKEN_ENDPOINT],
  );
  await assertRejects(() => refresh('https://169.254.169.254/token'), Error, 'blocked');
  await assertRejects(
    () => refresh('http://auth.example.com/token'),
    Error,
    'must be an https URL',
  );
  assertEquals(seen.length, 1);
});

Deno.test('tokenAudienceCovers holds a token to its resource origin and path', () => {
  const at = (url: string) => new URL(url);
  assertEquals(
    tokenAudienceCovers('https://api.example.com/mcp', at('https://api.example.com/mcp')),
    true,
  );
  assertEquals(
    tokenAudienceCovers('https://api.example.com/mcp', at('https://api.example.com/mcp/tools?x=1')),
    true,
  );
  assertEquals(
    tokenAudienceCovers('https://api.example.com/mcp', at('https://api.example.com/mcpx')),
    false,
  );
  assertEquals(
    tokenAudienceCovers('https://api.example.com/mcp', at('https://api.example.com/')),
    false,
  );
  assertEquals(
    tokenAudienceCovers('https://api.example.com', at('https://api.example.com/any/path')),
    true,
  );
  assertEquals(
    tokenAudienceCovers('https://api.example.com', at('https://evil.example.com/')),
    false,
  );
  assertEquals(tokenAudienceCovers('not a url', at('https://api.example.com/')), false);
});

Deno.test('every flow names its resource, even when the host supplies the endpoints', async () => {
  const flow = await createOAuthPkceFlow({
    resourceServerUrl: RESOURCE,
    clientId: 'my-client-id',
    redirectUri: REDIRECT,
    signingSecret: SECRET,
    sessionBinding: SESSION,
    preResolved: PRE_RESOLVED,
  });
  assertEquals(flow.resource, RESOURCE);
  assertEquals(new URL(flow.authorizationUrl).searchParams.get('resource'), RESOURCE);
  await assertRejects(
    () =>
      createOAuthPkceFlow({
        resourceServerUrl: 'http://mcp.example.com',
        clientId: 'my-client-id',
        redirectUri: REDIRECT,
        signingSecret: SECRET,
        sessionBinding: SESSION,
        preResolved: PRE_RESOLVED,
      }),
    Error,
    'must be an https URL',
  );
});

Deno.test('a flow refuses a loose redirect_uri, client_id, scope, or state lifetime', async () => {
  const start = (over: Partial<Parameters<typeof createOAuthPkceFlow>[0]>) =>
    createOAuthPkceFlow({
      resourceServerUrl: RESOURCE,
      clientId: 'my-client-id',
      redirectUri: REDIRECT,
      signingSecret: SECRET,
      sessionBinding: SESSION,
      preResolved: PRE_RESOLVED,
      ...over,
    });
  for (const redirectUri of [
    'http://my-host.com/cb',
    'https://my-host.com/cb#frag',
    'https://my-host.com/cb#',
    'javascript:alert(1)',
    'data:text/html,x',
    '/relative/cb',
  ]) {
    await assertRejects(() => start({ redirectUri }), Error, 'redirect_uri');
  }
  for (const redirectUri of [
    'http://127.0.0.1:8123/cb',
    'http://[::1]:8123/cb',
    'http://localhost:8123/cb',
    'com.example.app:/oauth/cb',
  ]) {
    await start({ redirectUri });
  }
  await assertRejects(
    () => start({ clientId: 'http://client.example/meta.json' }),
    Error,
    'client_id',
  );
  await assertRejects(() => start({ clientId: '' }), Error, 'client_id');
  await start({ clientId: 'https://client.example/meta.json' });
  for (const scope of ['read write', '', 'a"b', 'a\\b']) {
    await assertRejects(() => start({ scopes: [scope] }), Error, 'scope token');
  }
  for (const stateTtlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assertRejects(() => start({ stateTtlMs }), RangeError, 'stateTtlMs');
  }
});

Deno.test('every sealed state has its own key and names its envelope version', async () => {
  const payload = statePayload();
  const [a, b] = await Promise.all([
    sealStatePayload(payload, SECRET),
    sealStatePayload(payload, SECRET),
  ]);
  const [versionA, saltA] = a.split('.');
  const [, saltB] = b.split('.');
  assertEquals(versionA, 'v1');
  assertEquals(fromBase64Url(saltA ?? '').length, 32);
  assertEquals(saltA === saltB, false);
  assertEquals(await unsealStatePayload(b, SECRET), payload);
});

Deno.test('a typed secret becomes the credential its gate waits for, and never an OAuth one', () => {
  assertEquals(credentialFromTypedSecret('bearer', '  typed-token  '), {
    type: 'bearer',
    token: 'typed-token',
  });
  assertEquals(credentialFromTypedSecret('api_key', 'typed-key'), {
    type: 'api_key',
    key: 'typed-key',
  });
  assertThrows(() => credentialFromTypedSecret('oauth2', 'pasted-token'), Error, 'callback');
  assertThrows(() => credentialFromTypedSecret('bearer', '   '), Error, 'non-empty');
  assertThrows(() => credentialFromTypedSecret('api_key', { key: 'x' }), Error, 'non-empty');
});

Deno.test('OAuth discovery refuses a server whose name resolves inward', async () => {
  const { fetchFn, seen } = routes({});
  await assertRejects(
    () =>
      discoverResourceMetadata(RESOURCE, {
        fetchFn,
        resolveHost: () => Promise.resolve(['10.1.2.3']),
      }),
    Error,
    'resolves to private address "10.1.2.3"',
  );
  assertEquals(seen.length, 0);
});
