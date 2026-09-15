import {
  computeCodeChallenge,
  generateCodeVerifier,
  sealStatePayload,
  unsealStatePayload,
} from '../../src/kernel/auth/crypto.ts';
import {
  createOAuthPkceFlow,
  discoverAuthServerMetadata,
  exchangeOAuthPkce,
  refreshOAuthToken,
  validateIssuer,
} from '../../src/kernel/auth/oauth.ts';
import { assertEquals, assertRejects, assertThrows } from '../../src/kernel/engine/assert.ts';

Deno.test('PKCE code challenge matches RFC 7636 Appendix B test vector', async () => {
  // Test vector from RFC 7636 Appendix B:
  // verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
  // challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const expectedChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  const challenge = await computeCodeChallenge(verifier);
  assertEquals(challenge, expectedChallenge);
});

Deno.test('generateCodeVerifier creates valid length and characters', () => {
  const v = generateCodeVerifier(64);
  assertEquals(v.length, 64);
  assertEquals(/^[A-Za-z0-9\-._~]+$/.test(v), true);

  // RFC 7636 Section 4.1 bounds: 43 to 128 characters
  assertThrows(() => generateCodeVerifier(42), RangeError, 'RFC 7636 Section 4.1');
  assertThrows(() => generateCodeVerifier(129), RangeError, 'RFC 7636 Section 4.1');
});

Deno.test('stateless HMAC state envelope seals and unseals correctly', async () => {
  const secret = 'test-signing-secret-key-12345';
  const payload = {
    codeVerifier: 'test-code-verifier-value',
    expectedIssuer: 'https://auth.example.com',
    resource: 'https://mcp.example.com',
    redirectUri: 'https://my-app.com/callback',
    expiresAt: Date.now() + 60000,
    clientId: 'test-client-123',
  };

  const sealed = await sealStatePayload(payload, secret);
  const unsealed = await unsealStatePayload(sealed, secret);

  assertEquals(unsealed.codeVerifier, payload.codeVerifier);
  assertEquals(unsealed.expectedIssuer, payload.expectedIssuer);
  assertEquals(unsealed.resource, payload.resource);
  assertEquals(unsealed.clientId, payload.clientId);
});

Deno.test('unsealStatePayload rejects tampered state envelope', async () => {
  const secret = 'test-signing-secret-key-12345';
  const payload = {
    codeVerifier: 'verifier',
    expectedIssuer: 'https://auth.example.com',
    redirectUri: 'https://my-app.com/callback',
    expiresAt: Date.now() + 60000,
    clientId: 'client-1',
  };

  const sealed = await sealStatePayload(payload, secret);
  const tampered = sealed.replace(/^[A-Za-z0-9]/, 'Z');

  await assertRejects(
    () => unsealStatePayload(tampered, secret),
    Error,
    'HMAC signature verification failed',
  );

  // Malformed base64url or split count
  await assertRejects(() => unsealStatePayload('not-a-valid-envelope', secret), Error);
  await assertRejects(() => unsealStatePayload('part1.part2.part3', secret), Error);
});

Deno.test('unsealStatePayload rejects expired state envelope', async () => {
  const secret = 'test-signing-secret-key-12345';
  const payload = {
    codeVerifier: 'verifier',
    expectedIssuer: 'https://auth.example.com',
    redirectUri: 'https://my-app.com/callback',
    expiresAt: Date.now() - 1000, // expired
    clientId: 'client-1',
  };

  const sealed = await sealStatePayload(payload, secret);

  await assertRejects(() => unsealStatePayload(sealed, secret), Error, 'OAuth state has expired');
});

Deno.test('validateIssuer enforces byte-exact match per RFC 9207', () => {
  // Matches
  validateIssuer('https://auth.example.com', 'https://auth.example.com');
  validateIssuer('https://auth.example.com', undefined);

  // Mismatch throws
  assertThrows(
    () => validateIssuer('https://auth.example.com', 'https://attacker.example.com'),
    Error,
    'RFC 9207 Issuer mismatch detected',
  );
  // Trailing slash difference is NOT normalized per 2026 spec
  assertThrows(
    () => validateIssuer('https://auth.example.com', 'https://auth.example.com/'),
    Error,
    'RFC 9207 Issuer mismatch detected',
  );
});

Deno.test('createOAuthPkceFlow constructs compliant authorization URL with resource and S256', async () => {
  const secret = 'test-secret';
  const flow = await createOAuthPkceFlow({
    resourceServerUrl: 'https://mcp.example.com',
    clientId: 'my-client-id',
    redirectUri: 'https://my-host.com/oauth/callback',
    scopes: ['read', 'write'],
    signingSecret: secret,
    preResolved: {
      issuer: 'https://auth.example.com',
      authorizationEndpoint: 'https://auth.example.com/oauth/authorize',
      tokenEndpoint: 'https://auth.example.com/oauth/token',
      resource: 'https://mcp.example.com',
    },
  });

  const parsedUrl = new URL(flow.authorizationUrl);
  assertEquals(parsedUrl.origin, 'https://auth.example.com');
  assertEquals(parsedUrl.pathname, '/oauth/authorize');
  assertEquals(parsedUrl.searchParams.get('response_type'), 'code');
  assertEquals(parsedUrl.searchParams.get('client_id'), 'my-client-id');
  assertEquals(parsedUrl.searchParams.get('code_challenge_method'), 'S256');
  assertEquals(parsedUrl.searchParams.get('resource'), 'https://mcp.example.com');
  assertEquals(parsedUrl.searchParams.get('scope'), 'read write');
  assertEquals(parsedUrl.searchParams.get('code_challenge'), flow.codeChallenge);
});

Deno.test('exchangeOAuthPkce verifies state and exchanges code', async () => {
  const secret = 'test-secret';
  const flow = await createOAuthPkceFlow({
    resourceServerUrl: 'https://mcp.example.com',
    clientId: 'my-client-id',
    redirectUri: 'https://my-host.com/oauth/callback',
    signingSecret: secret,
    preResolved: {
      issuer: 'https://auth.example.com',
      authorizationEndpoint: 'https://auth.example.com/oauth/authorize',
      tokenEndpoint: 'https://auth.example.com/oauth/token',
      resource: 'https://mcp.example.com',
    },
  });

  let tokenRequestBody = '';
  const mockFetch: typeof fetch = (_input, init) => {
    tokenRequestBody = String(init?.body ?? '');
    return Promise.resolve(
      new Response(
        JSON.stringify({
          access_token: 'mock-access-token-xyz',
          refresh_token: 'mock-refresh-token-abc',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  };

  const result = await exchangeOAuthPkce({
    code: 'mock-auth-code-123',
    state: flow.state,
    iss: 'https://auth.example.com',
    redirectUri: 'https://my-host.com/oauth/callback',
    signingSecret: secret,
    tokenEndpoint: 'https://auth.example.com/oauth/token',
    fetchFn: mockFetch,
  });

  assertEquals(result.tokens.access_token, 'mock-access-token-xyz');
  assertEquals(result.credential.accessToken, 'mock-access-token-xyz');
  assertEquals(result.credential.refreshToken, 'mock-refresh-token-abc');
  assertEquals(result.credential.issuer, 'https://auth.example.com');
  assertEquals(result.credential.resource, 'https://mcp.example.com');

  const parsedBody = new URLSearchParams(tokenRequestBody);
  assertEquals(parsedBody.get('grant_type'), 'authorization_code');
  assertEquals(parsedBody.get('code'), 'mock-auth-code-123');
  assertEquals(parsedBody.get('code_verifier'), flow.codeVerifier);
  assertEquals(parsedBody.get('resource'), 'https://mcp.example.com');

  // Mismatched redirect_uri fails per RFC 6749 Section 4.1.3
  await assertRejects(
    () =>
      exchangeOAuthPkce({
        code: 'mock-code',
        state: flow.state,
        redirectUri: 'https://attacker.com/evil',
        signingSecret: secret,
        fetchFn: mockFetch,
      }),
    Error,
    'Redirect URI mismatch',
  );
});

Deno.test('refreshOAuthToken calls token endpoint with refresh_token grant', async () => {
  let requestBody = '';
  const mockFetch: typeof fetch = (_input, init) => {
    requestBody = String(init?.body ?? '');
    return Promise.resolve(
      new Response(
        JSON.stringify({
          access_token: 'new-refreshed-token-999',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  };

  const result = await refreshOAuthToken({
    refreshToken: 'old-refresh-token',
    tokenEndpoint: 'https://auth.example.com/oauth/token',
    clientId: 'my-client',
    issuer: 'https://auth.example.com',
    resource: 'https://mcp.example.com',
    fetchFn: mockFetch,
  });

  assertEquals(result.tokens.access_token, 'new-refreshed-token-999');
  assertEquals(result.credential.accessToken, 'new-refreshed-token-999');
  assertEquals(result.credential.refreshToken, 'old-refresh-token'); // Preserved
  const parsedBody = new URLSearchParams(requestBody);
  assertEquals(parsedBody.get('grant_type'), 'refresh_token');
  assertEquals(parsedBody.get('refresh_token'), 'old-refresh-token');
});

Deno.test('discoverAuthServerMetadata prefers oauth-authorization-server then OIDC', async () => {
  const urls: string[] = [];
  const mockFetch: typeof fetch = (input) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/oauth/authorize',
            token_endpoint: 'https://auth.example.com/oauth/token',
            registration_endpoint: 'https://auth.example.com/register',
            scopes_supported: ['openid'],
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code'],
            code_challenge_methods_supported: ['S256'],
            authorization_response_iss_parameter_supported: true,
            client_id_metadata_document_supported: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };

  const meta = await discoverAuthServerMetadata('https://auth.example.com/', mockFetch);
  assertEquals(meta.issuer, 'https://auth.example.com');
  assertEquals(meta.authorization_endpoint, 'https://auth.example.com/oauth/authorize');
  assertEquals(meta.token_endpoint, 'https://auth.example.com/oauth/token');
  assertEquals(meta.registration_endpoint, 'https://auth.example.com/register');
  assertEquals(meta.scopes_supported, ['openid']);
  assertEquals(meta.authorization_response_iss_parameter_supported, true);
  assertEquals(meta.client_id_metadata_document_supported, true);
  assertEquals(urls[0], 'https://auth.example.com/.well-known/oauth-authorization-server');
});

Deno.test('discoverAuthServerMetadata falls back to openid-configuration', async () => {
  const mockFetch: typeof fetch = (input) => {
    const url = String(input);
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return Promise.resolve(new Response('missing', { status: 404 }));
    }
    if (url.endsWith('/.well-known/openid-configuration')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };

  const meta = await discoverAuthServerMetadata('https://auth.example.com', mockFetch);
  assertEquals(meta.issuer, 'https://auth.example.com');
  assertEquals(meta.authorization_endpoint, 'https://auth.example.com/authorize');
  assertEquals(meta.token_endpoint, 'https://auth.example.com/token');
});

Deno.test('discoverAuthServerMetadata rejects incomplete or unreachable metadata', async () => {
  const incomplete: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ issuer: 'https://auth.example.com' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  await assertRejects(
    () => discoverAuthServerMetadata('https://auth.example.com', incomplete),
    Error,
    'Failed to discover authorization server metadata',
  );

  const exploding: typeof fetch = () => {
    throw new Error('network down');
  };
  await assertRejects(
    () => discoverAuthServerMetadata('https://auth.example.com', exploding),
    Error,
    'Failed to discover authorization server metadata',
  );
});
