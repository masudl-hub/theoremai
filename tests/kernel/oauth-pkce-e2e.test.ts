/**
 * End-to-end PKCE: a real authorization server on localhost HTTPS that checks
 * RFC 7636 S256 itself, driven only through the package's public OAuth helpers.
 * The unit tests in auth.test.ts stub fetch; here the server is independent, so
 * a flow that passes has been verified by the other side, not by our own code.
 *
 * The TLS certificates are made fresh for each run with `openssl`.
 */
import {
  createOAuthPkceFlow,
  exchangeOAuthPkce,
  refreshOAuthToken,
} from '../../src/kernel/auth/mod.ts';
import { assertEquals, assertRejects } from '../../src/kernel/engine/assert.ts';

const SECRET = 'e2e-synthetic-state-secret-0123456789';
const REDIRECT = 'https://app.example/oauth/callback';
const CLIENT_ID = 'https://app.example/oauth/client.json';
const VICTIM = 'victim-session-cookie-value';

const encoder = new TextEncoder();
const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const s256 = async (verifier: string) =>
  base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));

async function openssl(dir: string, args: string[]): Promise<void> {
  const { success, stderr } = await new Deno.Command('openssl', {
    args,
    cwd: dir,
    stdout: 'null',
    stderr: 'piped',
  }).output();
  if (!success) throw new Error(`openssl ${args[0]} failed: ${new TextDecoder().decode(stderr)}`);
}

/** A throwaway CA and a `localhost` server certificate it signed. */
async function localhostCertificates(): Promise<{ ca: string; cert: string; key: string }> {
  const dir = await Deno.makeTempDir({ prefix: 'theorem-pkce-e2e-' });
  try {
    await openssl(dir, [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca-key.pem',
      '-out',
      'ca.pem',
      '-days',
      '1',
      '-subj',
      '/CN=theorem-e2e-ca',
    ]);
    await openssl(dir, [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'key.pem',
      '-out',
      'leaf.csr',
      '-subj',
      '/CN=localhost',
    ]);
    await Deno.writeTextFile(
      `${dir}/ext.cnf`,
      'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n',
    );
    await openssl(dir, [
      'x509',
      '-req',
      '-in',
      'leaf.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca-key.pem',
      '-CAcreateserial',
      '-out',
      'cert.pem',
      '-days',
      '1',
      '-extfile',
      'ext.cnf',
    ]);
    const read = (name: string) => Deno.readTextFile(`${dir}/${name}`);
    return { ca: await read('ca.pem'), cert: await read('cert.pem'), key: await read('key.pem') };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

type Grant = {
  challenge: string;
  redirectUri: string;
  clientId: string;
  resource: string | null;
  used: boolean;
};

/** An authorization server that issues codes, verifies PKCE, and rotates refresh tokens. */
function authorizationServer(certificates: { cert: string; key: string }) {
  const codes = new Map<string, Grant>();
  const refreshTokens = new Set<string>();
  const tokenRequests: Record<string, string>[] = [];
  let base = '';
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const issue = () => {
    const refresh = crypto.randomUUID();
    refreshTokens.add(refresh);
    return json({
      access_token: crypto.randomUUID(),
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refresh,
    });
  };

  async function token(form: Record<string, string>): Promise<Response> {
    tokenRequests.push(form);
    if (form.grant_type === 'refresh_token') {
      return refreshTokens.delete(form.refresh_token)
        ? issue()
        : json({ error: 'invalid_grant' }, 400);
    }
    if (form.grant_type !== 'authorization_code')
      return json({ error: 'unsupported_grant_type' }, 400);
    const grant = codes.get(form.code);
    if (!grant) return json({ error: 'invalid_grant', error_description: 'unknown code' }, 400);
    if (grant.used)
      return json({ error: 'invalid_grant', error_description: 'code already used' }, 400);
    grant.used = true;
    if (form.redirect_uri !== grant.redirectUri)
      return json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
    if (form.client_id !== grant.clientId) return json({ error: 'invalid_client' }, 401);
    if (form.resource !== grant.resource) return json({ error: 'invalid_target' }, 400);
    if (!form.code_verifier || (await s256(form.code_verifier)) !== grant.challenge) {
      return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
    }
    return issue();
  }

  /** The user approves: the server keeps the challenge and redirects back with a code. */
  function authorize(params: URLSearchParams): Response {
    if (params.get('response_type') !== 'code')
      return json({ error: 'unsupported_response_type' }, 400);
    const challenge = params.get('code_challenge');
    const redirectUri = params.get('redirect_uri');
    if (!challenge || params.get('code_challenge_method') !== 'S256' || !redirectUri) {
      return json({ error: 'invalid_request', error_description: 'S256 PKCE required' }, 400);
    }
    const code = crypto.randomUUID();
    codes.set(code, {
      challenge,
      redirectUri,
      clientId: params.get('client_id') ?? '',
      resource: params.get('resource'),
      used: false,
    });
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', params.get('state') ?? '');
    back.searchParams.set('iss', base);
    return new Response(null, { status: 302, headers: { Location: back.href } });
  }

  const server = Deno.serve(
    {
      port: 0,
      hostname: 'localhost',
      cert: certificates.cert,
      key: certificates.key,
      onListen: () => {},
    },
    async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        return json({ resource: `${base}/mcp`, authorization_servers: [base] });
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          code_challenge_methods_supported: ['S256'],
          authorization_response_iss_parameter_supported: true,
        });
      }
      if (url.pathname === '/authorize') return authorize(url.searchParams);
      if (url.pathname === '/token' && request.method === 'POST') {
        return token(Object.fromEntries(new URLSearchParams(await request.text())));
      }
      return new Response('not found', { status: 404 });
    },
  );
  base = `https://localhost:${server.addr.port}`;
  return { base, server, tokenRequests };
}

Deno.test('OAuth PKCE end to end against a real authorization server', async (t) => {
  const certificates = await localhostCertificates();
  const { base, server, tokenRequests } = authorizationServer(certificates);
  const client = Deno.createHttpClient({ caCerts: [certificates.ca] });
  const fetchFn: typeof fetch = (input, init) => fetch(input, { ...init, client });
  const transport = { network: { allowPrivateNetworks: true, allowedSchemes: ['https'] }, fetchFn };
  const resource = `${base}/mcp`;

  /** Starts a flow, then plays the browser and the user's consent. */
  async function signIn(options: { stateTtlMs?: number; sessionBinding?: string } = {}) {
    const flow = await createOAuthPkceFlow({
      resourceServerUrl: resource,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      scopes: ['read'],
      signingSecret: SECRET,
      stateTtlMs: options.stateTtlMs,
      sessionBinding: options.sessionBinding ?? VICTIM,
      ...transport,
    });
    const consent = await fetchFn(flow.authorizationUrl, { redirect: 'manual' });
    await consent.body?.cancel();
    const back = new URL(consent.headers.get('location') ?? 'https://missing.invalid');
    return {
      flow,
      callback: {
        code: back.searchParams.get('code') ?? '',
        state: back.searchParams.get('state') ?? '',
        iss: back.searchParams.get('iss') ?? undefined,
      },
    };
  }
  const exchange = (
    callback: { code: string; state: string; iss?: string },
    overrides: { signingSecret?: string; redirectUri?: string; sessionBinding?: string } = {},
  ) =>
    exchangeOAuthPkce({
      ...callback,
      redirectUri: REDIRECT,
      signingSecret: SECRET,
      sessionBinding: VICTIM,
      ...transport,
      ...overrides,
    });

  try {
    await t.step('a flow is verified by the server and refreshes with rotation', async () => {
      const { flow, callback } = await signIn();
      const authorizeUrl = new URL(flow.authorizationUrl);
      assertEquals(flow.issuer, base);
      assertEquals(flow.resource, resource);
      assertEquals(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
      assertEquals(authorizeUrl.searchParams.get('resource'), resource);
      assertEquals(authorizeUrl.searchParams.get('scope'), 'read');
      assertEquals('codeVerifier' in flow, false);

      const { credential } = await exchange(callback);
      assertEquals(credential.accessToken.length > 0, true);
      const sent = tokenRequests.at(-1);
      assertEquals(await s256(sent?.code_verifier ?? ''), flow.codeChallenge);
      assertEquals(sent?.redirect_uri, REDIRECT);
      assertEquals(sent?.resource, resource);
      assertEquals(credential.issuer, base);
      assertEquals(credential.resource, resource);
      assertEquals(credential.tokenEndpoint, `${base}/token`);

      const refreshed = await refreshOAuthToken({
        refreshToken: credential.refreshToken ?? '',
        tokenEndpoint: credential.tokenEndpoint,
        clientId: credential.clientId,
        resource: credential.resource,
        issuer: credential.issuer,
        ...transport,
      });
      assertEquals(refreshed.credential.accessToken !== credential.accessToken, true);
      assertEquals(refreshed.credential.refreshToken !== credential.refreshToken, true);

      await assertRejects(() => exchange(callback), Error, 'code already used');
    });

    await t.step("one flow's code with another flow's state fails PKCE at the server", async () => {
      const first = await signIn();
      const second = await signIn();
      await assertRejects(
        () => exchange({ ...first.callback, state: second.callback.state }),
        Error,
        'PKCE verification failed',
      );
    });

    await t.step('the callback is refused when it was not meant for this flow', async () => {
      const { callback } = await signIn();
      await assertRejects(() => exchange({ ...callback, iss: undefined }), Error, 'iss');
      await assertRejects(
        () => exchange({ ...callback, iss: 'https://evil.example' }),
        Error,
        'Issuer mismatch',
      );
      await assertRejects(
        () => exchange({ ...callback, state: `${callback.state.slice(0, -2)}AA` }),
        Error,
        'could not be opened',
      );
      await assertRejects(
        () => exchange(callback, { signingSecret: 'another-synthetic-secret-0123456789ab' }),
        Error,
        'could not be opened',
      );
      await assertRejects(
        () => exchange(callback, { redirectUri: 'https://evil.example/cb' }),
        Error,
        'Redirect URI mismatch',
      );
    });

    await t.step('an expired state is refused', async () => {
      const { callback } = await signIn({ stateTtlMs: 1 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await assertRejects(() => exchange(callback), Error, 'expired');
    });

    await t.step(
      "login CSRF: an attacker's callback replayed into another session is refused",
      async () => {
        const { callback } = await signIn({ sessionBinding: 'attacker-session-cookie-value' });
        await assertRejects(() => exchange(callback), Error, 'belongs to another session');
      },
    );

    await t.step(
      'a short state secret and an unpermitted loopback server are refused',
      async () => {
        const flow = {
          resourceServerUrl: resource,
          clientId: CLIENT_ID,
          redirectUri: REDIRECT,
          sessionBinding: VICTIM,
        };
        await assertRejects(
          () => createOAuthPkceFlow({ ...flow, signingSecret: 'short', ...transport }),
          Error,
          'at least 32 bytes',
        );
        await assertRejects(
          () => createOAuthPkceFlow({ ...flow, signingSecret: SECRET, fetchFn }),
          Error,
          'loopback',
        );
      },
    );
  } finally {
    client.close();
    await server.shutdown();
  }
});
