import { sealStatePayload, toBase64Url, unsealStatePayload } from '../../src/kernel/auth/crypto.ts';
import {
  createOAuthPkceFlow,
  discoverAuthServerMetadata,
  discoverResourceMetadata,
  exchangeOAuthPkce,
  refreshOAuthToken,
  tokenAudienceCovers,
} from '../../src/kernel/auth/oauth.ts';
import { authScopeRefusedSchema } from '../../src/kernel/auth/scope-refusal.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

/** Names the case that failed; `assertEquals` takes only the two values. */
function check(actual: unknown, expected: unknown, label: string): void {
  assertEquals({ label, value: actual }, { label, value: expected });
}

const SECRET = 'a-host-secret-of-more-than-thirty-two-bytes';
const SESSION = 'session-of-the-user-who-began-the-flow';
const ISSUER = 'https://auth.example.com';
const RESOURCE = 'https://api.example.com/mcp';
const REDIRECT = 'https://my-host.com/oauth/callback';
const TOKEN_ENDPOINT = 'https://auth.example.com/oauth/token';
const AUTHORIZE = 'https://auth.example.com/oauth/authorize';
const PRE_RESOLVED = {
  issuer: ISSUER,
  authorizationEndpoint: AUTHORIZE,
  tokenEndpoint: TOKEN_ENDPOINT,
};
const BEARER = { access_token: 'tok', token_type: 'Bearer' };

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
    seen.push({ url: String(input), init });
    const route = table[String(input)];
    return Promise.resolve(route ? route() : new Response('not found', { status: 404 }));
  };
  return { fetchFn, seen };
}

const AS_METADATA = {
  issuer: ISSUER,
  authorization_endpoint: AUTHORIZE,
  token_endpoint: TOKEN_ENDPOINT,
  code_challenge_methods_supported: ['S256'],
};

const AS_URL = `${ISSUER}/.well-known/oauth-authorization-server`;
const RS_URL = 'https://api.example.com/.well-known/oauth-protected-resource/mcp';

function flowOptions(over: Record<string, unknown> = {}) {
  return {
    resourceServerUrl: RESOURCE,
    clientId: 'client',
    redirectUri: REDIRECT,
    signingSecret: SECRET,
    sessionBinding: SESSION,
    preResolved: PRE_RESOLVED,
    ...over,
  };
}

async function rejection(body: () => Promise<unknown>): Promise<string> {
  try {
    await body();
    return 'resolved';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Runs the body with `Date.now` frozen. */
async function atTime<T>(now: number, body: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => now;
  try {
    return await body();
  } finally {
    Date.now = real;
  }
}

async function flowFor(over: Record<string, unknown> = {}) {
  return createOAuthPkceFlow(flowOptions(over));
}

async function exchangeWith(
  response: () => Response,
  over: { flow?: Record<string, unknown>; secret?: string } = {},
) {
  const flow = await flowFor(over.flow);
  const { fetchFn, seen } = routes({ [TOKEN_ENDPOINT]: response });
  const run = () =>
    exchangeOAuthPkce({
      code: 'code',
      state: flow.state,
      redirectUri: REDIRECT,
      signingSecret: SECRET,
      sessionBinding: SESSION,
      fetchFn,
      ...(over.secret ? { clientSecret: over.secret } : {}),
    });
  return { run, seen };
}

Deno.test('a URL the flow is given must parse, be https and carry no fragment', async () => {
  check(
    await rejection(() => flowFor({ preResolved: { ...PRE_RESOLVED, issuer: 'not a url' } })),
    'OAuth issuer "not a url" is not a URL',
    'not a URL',
  );
  check(
    await rejection(() =>
      flowFor({ preResolved: { ...PRE_RESOLVED, issuer: 'http://auth.example.com' } }),
    ),
    'OAuth issuer "http://auth.example.com" must be an https URL without a fragment',
    'http issuer',
  );
  check(
    await rejection(() =>
      flowFor({ preResolved: { ...PRE_RESOLVED, tokenEndpoint: `${TOKEN_ENDPOINT}#x` } }),
    ),
    `OAuth token_endpoint "${TOKEN_ENDPOINT}#x" must be an https URL without a fragment`,
    'fragment',
  );
});

Deno.test('a redirect_uri is https, loopback http, or a reverse-domain app scheme, and has no fragment', async () => {
  for (const ok of [
    'https://app.example.com/cb',
    'http://127.0.0.1/cb',
    'http://localhost:8080/cb',
    'http://[::1]/cb',
    'com.example.app:/cb',
  ]) {
    check(await rejection(() => flowFor({ redirectUri: ok })), 'resolved', `accepts ${ok}`);
  }
  for (const bad of [
    'http://example.com/cb',
    'http://10.0.0.1/cb',
    'myapp://cb',
    'ftp://example.com/cb',
    'https://app.example.com/cb#frag',
    'com.example.app:/cb#frag',
  ]) {
    check(
      await rejection(() => flowFor({ redirectUri: bad })),
      `OAuth redirect_uri "${bad}" must be https, http on loopback, or a reverse-domain app scheme, without a fragment`,
      `refuses ${bad}`,
    );
  }
  check(
    await rejection(() => flowFor({ redirectUri: 'not absolute' })),
    'OAuth redirect_uri "not absolute" is not an absolute URI',
    'not a URI',
  );
});

Deno.test('a client_id that is a URL must be https, and one that merely contains "http:" is only a name', async () => {
  check(
    await rejection(() => flowFor({ clientId: 'abchttp://x' })),
    'resolved',
    'name containing http:',
  );
  check(
    await rejection(() => flowFor({ clientId: 'https://client.example/meta.json' })),
    'resolved',
    'https URL',
  );
  check(
    await rejection(() => flowFor({ clientId: 'HTTP://client.example/meta.json' })),
    'OAuth client_id "HTTP://client.example/meta.json" must be an https URL without a fragment',
    'http URL, any case',
  );
  check(await rejection(() => flowFor({ clientId: '' })), 'OAuth client_id is missing', 'empty');
});

Deno.test('the state lives ten minutes unless told otherwise, and holds the scopes asked for', async () => {
  await atTime(1_000_000, async () => {
    const plain = await flowFor();
    const sealed = await unsealStatePayload(plain.state, SECRET);
    check(sealed.expiresAt, 1_000_000 + 600_000, 'ten minutes');
    check(sealed.scopes, [], 'no scopes by default');

    const scoped = await flowFor({ scopes: ['a', 'b'], stateTtlMs: 5_000 });
    const held = await unsealStatePayload(scoped.state, SECRET);
    check(held.expiresAt, 1_005_000, 'the ttl given');
    check(held.scopes, ['a', 'b'], 'scopes held');
  });
});

Deno.test('the authorization URL carries scope only when scopes were asked for', async () => {
  const query = (url: string) => new URL(url).searchParams;
  check(query((await flowFor()).authorizationUrl).get('scope'), null, 'none by default');
  check(query((await flowFor({ scopes: [] })).authorizationUrl).get('scope'), null, 'empty list');
  check(
    query((await flowFor({ scopes: ['a', 'b'] })).authorizationUrl).get('scope'),
    'a b',
    'two scopes',
  );
});

Deno.test('discovery names a malformed or empty answer instead of using it', async () => {
  const get = (url: string, answer: () => Response) =>
    discoverResourceMetadata(RESOURCE, { fetchFn: routes({ [url]: answer }).fetchFn });
  check(
    await rejection(() =>
      get(RS_URL, () => json({ resource: RESOURCE, authorization_servers: 'x' })),
    ),
    'OAuth metadata "authorization_servers" must be a list of strings',
    'string, not list',
  );
  check(
    await rejection(() =>
      get(RS_URL, () => json({ resource: RESOURCE, authorization_servers: [1] })),
    ),
    'OAuth metadata "authorization_servers" must be a list of strings',
    'numbers',
  );
  check(
    await rejection(() =>
      get(RS_URL, () => json({ resource: RESOURCE, authorization_servers: [ISSUER, 2] })),
    ),
    'OAuth metadata "authorization_servers" must be a list of strings',
    'one number among strings',
  );
  for (const body of [[1], 'text', null, 5]) {
    check(
      await rejection(() => get(RS_URL, () => json(body))),
      `OAuth metadata at ${RS_URL} is not a JSON object`,
      `body ${JSON.stringify(body)}`,
    );
  }
  for (const servers of [undefined, []]) {
    check(
      await rejection(() =>
        get(RS_URL, () => json({ resource: RESOURCE, authorization_servers: servers })),
      ),
      `Protected resource metadata at ${RS_URL} did not declare any authorization_servers`,
      `servers ${JSON.stringify(servers)}`,
    );
  }
  check(
    await rejection(() =>
      get(RS_URL, () => json({ resource: RESOURCE, authorization_servers: ['http://x.example'] })),
    ),
    'OAuth authorization server "http://x.example" must be an https URL without a fragment',
    'http server',
  );
  check(
    await rejection(() => get(RS_URL, () => json({}, 500))),
    `Failed to discover protected resource metadata at ${RS_URL} (HTTP 500)`,
    'server error',
  );
});

Deno.test('discovery asks for JSON, and a refusal releases the response body', async () => {
  const { fetchFn, seen } = routes({
    [RS_URL]: () => json({ resource: RESOURCE, authorization_servers: [ISSUER] }),
    [AS_URL]: () => json(AS_METADATA),
  });
  await discoverResourceMetadata(RESOURCE, { fetchFn });
  await discoverAuthServerMetadata(ISSUER, { fetchFn });
  check(
    seen.map((s) => new Headers(s.init?.headers).get('accept')),
    ['application/json', 'application/json'],
    'accept header',
  );

  let cancelled = 0;
  const stream = () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
      { status: 404 },
    );
  check(
    await discoverResourceMetadata(RESOURCE, { fetchFn: routes({ [RS_URL]: stream }).fetchFn }),
    undefined,
    '404',
  );
  check(cancelled, 1, 'a 404 body is cancelled');
  await rejection(() =>
    discoverResourceMetadata(RESOURCE, {
      fetchFn: routes({
        [RS_URL]: () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled++;
              },
            }),
            { status: 500 },
          ),
      }).fetchFn,
    }),
  );
  check(cancelled, 2, 'a failed answer body is cancelled');
  await rejection(() =>
    discoverAuthServerMetadata(ISSUER, {
      fetchFn: routes({
        [AS_URL]: () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled++;
              },
            }),
            { status: 500 },
          ),
      }).fetchFn,
    }),
  );
  check(cancelled >= 3, true, 'a skipped metadata URL body is cancelled');
  check(
    await discoverResourceMetadata(RESOURCE, {
      fetchFn: routes({ [RS_URL]: () => new Response(null, { status: 404 }) }).fetchFn,
    }),
    undefined,
    'a 404 with no body',
  );
  check(
    await rejection(() =>
      discoverResourceMetadata(RESOURCE, {
        fetchFn: routes({ [RS_URL]: () => new Response(null, { status: 500 }) }).fetchFn,
      }),
    ),
    `Failed to discover protected resource metadata at ${RS_URL} (HTTP 500)`,
    'a 500 with no body',
  );
});

Deno.test('authorization server metadata is returned whole, with its optional parts as given', async () => {
  const full = {
    ...AS_METADATA,
    registration_endpoint: 'https://auth.example.com/register',
    scopes_supported: ['a'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
  check(
    await discoverAuthServerMetadata(ISSUER, {
      fetchFn: routes({ [AS_URL]: () => json(full) }).fetchFn,
    }),
    {
      issuer: ISSUER,
      authorization_endpoint: AUTHORIZE,
      token_endpoint: TOKEN_ENDPOINT,
      registration_endpoint: 'https://auth.example.com/register',
      scopes_supported: ['a'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    },
    'full',
  );
  check(
    await discoverAuthServerMetadata(ISSUER, {
      fetchFn: routes({ [AS_URL]: () => json(AS_METADATA) }).fetchFn,
    }),
    {
      issuer: ISSUER,
      authorization_endpoint: AUTHORIZE,
      token_endpoint: TOKEN_ENDPOINT,
      registration_endpoint: undefined,
      scopes_supported: undefined,
      response_types_supported: undefined,
      grant_types_supported: undefined,
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: false,
      client_id_metadata_document_supported: false,
    },
    'minimal',
  );
  for (const flag of [
    'authorization_response_iss_parameter_supported',
    'client_id_metadata_document_supported',
  ]) {
    const truthy = await discoverAuthServerMetadata(ISSUER, {
      fetchFn: routes({ [AS_URL]: () => json({ ...AS_METADATA, [flag]: 'yes' }) }).fetchFn,
    });
    check(
      (truthy as unknown as Record<string, unknown>)[flag],
      false,
      `${flag} only counts as true`,
    );
  }
});

Deno.test('metadata URLs are tried in order, and a path adds the appended OIDC form', async () => {
  const none = routes({});
  await rejection(() => discoverAuthServerMetadata(ISSUER, { fetchFn: none.fetchFn }));
  check(
    none.seen.map((s) => s.url),
    [AS_URL, `${ISSUER}/.well-known/openid-configuration`],
    'no path: two URLs',
  );
  const withPath = routes({});
  await rejection(() =>
    discoverAuthServerMetadata(`${ISSUER}/tenant`, { fetchFn: withPath.fetchFn }),
  );
  check(
    withPath.seen.map((s) => s.url),
    [
      `${ISSUER}/.well-known/oauth-authorization-server/tenant`,
      `${ISSUER}/.well-known/openid-configuration/tenant`,
      `${ISSUER}/tenant/.well-known/openid-configuration`,
    ],
    'path: three URLs',
  );
  check(
    await rejection(() => discoverAuthServerMetadata(`${ISSUER}?x=1`, { fetchFn: none.fetchFn })),
    `OAuth issuer "${ISSUER}?x=1" must not have a query`,
    'query',
  );
});

Deno.test('a server that does not advertise S256 is refused by name, and one that does not send iss is not made to', async () => {
  const bare = {
    issuer: ISSUER,
    authorization_endpoint: AUTHORIZE,
    token_endpoint: TOKEN_ENDPOINT,
  };
  const withoutMethods = routes({ [AS_URL]: () => json(bare) });
  check(
    await rejection(() =>
      createOAuthPkceFlow(
        flowOptions({
          preResolved: undefined,
          resourceServerUrl: ISSUER,
          fetchFn: withoutMethods.fetchFn,
        }),
      ),
    ),
    `Authorization server "${ISSUER}" does not advertise S256 PKCE (code_challenge_methods_supported)`,
    'no methods listed',
  );
  const plain = routes({ [AS_URL]: () => json(AS_METADATA), [TOKEN_ENDPOINT]: () => json(BEARER) });
  const flow = await createOAuthPkceFlow(
    flowOptions({ preResolved: undefined, resourceServerUrl: ISSUER, fetchFn: plain.fetchFn }),
  );
  check((await unsealStatePayload(flow.state, SECRET)).issRequired, false, 'iss not required');
});

Deno.test('a state whose session digest only starts like the presented one is another session', async () => {
  const digest = toBase64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SESSION))),
  );
  const sealed = (sessionBinding: string) =>
    sealStatePayload(
      {
        codeVerifier: 'v'.repeat(43),
        expectedIssuer: ISSUER,
        issRequired: false,
        tokenEndpoint: TOKEN_ENDPOINT,
        resource: RESOURCE,
        redirectUri: REDIRECT,
        expiresAt: Date.now() + 60_000,
        clientId: 'client',
        sessionBinding,
        scopes: [],
      },
      SECRET,
    );
  const { fetchFn } = routes({ [TOKEN_ENDPOINT]: () => json(BEARER) });
  const exchange = async (sessionBinding: string) =>
    rejection(async () =>
      exchangeOAuthPkce({
        code: 'c',
        state: await sealed(sessionBinding),
        redirectUri: REDIRECT,
        signingSecret: SECRET,
        sessionBinding: SESSION,
        fetchFn,
      }),
    );
  check(await exchange(digest), 'resolved', 'the same digest');
  for (const [label, bad] of [
    ['longer, same start', `${digest}x`],
    ['shorter', digest.slice(0, 10)],
    ['one character off', `${digest.slice(0, -1)}${digest.endsWith('A') ? 'B' : 'A'}`],
  ] as const) {
    check((await exchange(bad)).startsWith('OAuth state belongs to another session'), true, label);
  }
});

Deno.test('a token error repeats only what RFC 6749 §5.2 allows', async () => {
  const failure = async (body: () => Response) => {
    const { run } = await exchangeWith(body);
    return rejection(run);
  };
  const base = `Token exchange failed at ${TOKEN_ENDPOINT} (HTTP 400)`;
  check(
    await failure(() => json({ error: 'invalid_grant' }, 400)),
    `${base}: invalid_grant`,
    'error only',
  );
  check(
    await failure(() => json({ error: 'invalid_grant', error_description: 'code expired' }, 400)),
    `${base}: invalid_grant (code expired)`,
    'with description',
  );
  check(
    await failure(() => json({ error: 'invalid_grant', error_description: 'say "hi"' }, 400)),
    `${base}: invalid_grant`,
    'description with a quote',
  );
  check(
    await failure(() => json({ error: 'invalid_grant', error_description: 'back\\slash' }, 400)),
    `${base}: invalid_grant`,
    'description with a backslash',
  );
  check(
    await failure(() => json({ error: 'invalid_grant', error_description: 'café' }, 400)),
    `${base}: invalid_grant`,
    'description beyond ASCII',
  );
  check(
    await failure(() => json({ error: 'invalid_grant', error_description: 7 }, 400)),
    `${base}: invalid_grant`,
    'description that is not text',
  );
  check(await failure(() => json({ error: 'bad"error' }, 400)), base, 'error with a quote');
  check(await failure(() => json({ error: 'café' }, 400)), base, 'error beyond ASCII');
  check(await failure(() => json({ error: 5 }, 400)), base, 'error that is not text');
  check(await failure(() => json({}, 400)), base, 'no error');
  check(await failure(() => json([{ error: 'x' }], 400)), base, 'array body');
  check(await failure(() => json('x', 400)), base, 'string body');
  check(await failure(() => new Response('<html>', { status: 400 })), base, 'not JSON');
});

Deno.test('a token response is a bearer grant with sane fields, or it is refused by name', async () => {
  const refused = async (body: unknown) => {
    const { run } = await exchangeWith(() => json(body));
    return rejection(run);
  };
  const at = (why: string) => `Token response from ${TOKEN_ENDPOINT} ${why}`;
  check(await refused([1]), at('is not a JSON object'), 'array');
  check(await refused('x'), at('is not a JSON object'), 'string');
  check(await refused(null), at('is not a JSON object'), 'null');
  check(await refused({ token_type: 'Bearer' }), at('has no access_token'), 'no token');
  check(
    await refused({ access_token: '', token_type: 'Bearer' }),
    at('has no access_token'),
    'empty token',
  );
  check(
    await refused({ access_token: 5, token_type: 'Bearer' }),
    at('has no access_token'),
    'numeric token',
  );
  check(
    await refused({ access_token: 't' }),
    at('has token_type "undefined", not Bearer'),
    'no type',
  );
  check(
    await refused({ access_token: 't', token_type: 'mac' }),
    at('has token_type "mac", not Bearer'),
    'mac',
  );
  check(
    await refused({ access_token: 't', token_type: 5 }),
    at('has token_type "5", not Bearer'),
    'numeric type',
  );
  for (const expiresIn of ['3600', -1, null, true]) {
    check(
      await refused({ ...BEARER, expires_in: expiresIn }),
      at('has an expires_in that is not a number of seconds'),
      `expires_in ${JSON.stringify(expiresIn)}`,
    );
  }
  for (const field of ['refresh_token', 'scope']) {
    check(
      await refused({ ...BEARER, [field]: 5 }),
      at(`has a ${field} that is not a string`),
      `${field} number`,
    );
  }
  for (const accepted of [
    { ...BEARER, token_type: 'bearer' },
    { ...BEARER, expires_in: 0 },
    { ...BEARER, refresh_token: 'r', scope: 's' },
  ]) {
    const { run } = await exchangeWith(() => json(accepted));
    check((await run()).credential.accessToken, 'tok', `accepts ${JSON.stringify(accepted)}`);
  }
});

Deno.test('a credential expires expires_in seconds from now, and its scope is the grant, then the ask', async () => {
  await atTime(5_000, async () => {
    const run = async (body: Record<string, unknown>, flow: Record<string, unknown> = {}) => {
      const { run: go } = await exchangeWith(() => json({ ...BEARER, ...body }), { flow });
      return (await go()).credential;
    };
    check((await run({ expires_in: 60 })).expiresAt, 65_000, 'sixty seconds');
    check((await run({})).expiresAt, undefined, 'no expiry given');
    check((await run({ scope: 'a' }, { scopes: ['a', 'b'] })).scope, 'a', 'the grant wins');
    check((await run({}, { scopes: ['a', 'b'] })).scope, 'a b', 'else what was asked');
    check((await run({})).scope, undefined, 'else nothing');
    check((await run({ scope: 'z' })).scope, 'z', 'no ceiling when none was asked');
  });
});

Deno.test('a grant may hold no scope that was not asked for, and blank space between scopes is ignored', async () => {
  const exchange = (scope: string, scopes: string[]) =>
    exchangeWith(() => json({ ...BEARER, scope }), { flow: { scopes } }).then(({ run }) =>
      rejection(run),
    );
  check(
    await exchange('a b', ['a']),
    `Token response from ${TOKEN_ENDPOINT} grants scopes that were not asked for: b`,
    'one beyond',
  );
  check(await exchange('a  b', ['a', 'b']), 'resolved', 'a double space is not an empty scope');
  check(await exchange(' a', ['a']), 'resolved', 'a leading space is not an empty scope');
});

Deno.test('a refresh keeps what the server did not replace, asks for its scope, and holds the grant to it', async () => {
  const refresh = (response: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    const { fetchFn, seen } = routes({ [TOKEN_ENDPOINT]: () => json({ ...BEARER, ...response }) });
    const run = () =>
      refreshOAuthToken({
        issuer: ISSUER,
        resource: RESOURCE,
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: 'client',
        refreshToken: 'old-refresh',
        fetchFn,
        ...over,
      });
    return { run, seen };
  };
  const kept = await refresh({}, { scope: 'x y' }).run();
  check(kept.credential.refreshToken, 'old-refresh', 'refresh token kept');
  check(kept.credential.scope, 'x y', 'scope kept');
  const noScope = refresh({});
  check((await noScope.run()).credential.scope, undefined, 'no scope held, none given');
  check(
    new URLSearchParams(String(noScope.seen[0]?.init?.body)).get('scope'),
    null,
    'no scope param without one',
  );
  const scoped = refresh({}, { scope: 'x y' });
  await scoped.run();
  check(
    new URLSearchParams(String(scoped.seen[0]?.init?.body)).get('scope'),
    'x y',
    'scope param sent',
  );
  check(
    await rejection(() => refresh({ scope: 'x z' }, { scope: 'x y' }).run()),
    `Token response from ${TOKEN_ENDPOINT} grants scopes that were not asked for: z`,
    'ceiling is the scope asked for',
  );
  check(
    (await refresh({ scope: 'anything' }).run()).credential.scope,
    'anything',
    'no ceiling without a scope',
  );
  check(
    await rejection(() => refresh({}, { resource: 'http://api.example.com/mcp' }).run()),
    'OAuth resource "http://api.example.com/mcp" must be an https URL without a fragment',
    'resource must be https',
  );
  check(
    await rejection(() => refresh({}, { tokenEndpoint: 'http://auth.example.com/t' }).run()),
    'OAuth token_endpoint "http://auth.example.com/t" must be an https URL without a fragment',
    'token endpoint must be https',
  );
  const failed = await rejection(() =>
    refresh({})
      .run()
      .then(() => {
        throw new Error('unreachable');
      }),
  );
  check(failed, 'unreachable', 'the happy path resolves');
});

Deno.test('token requests are form posts that ask for JSON and carry the client secret only when there is one', async () => {
  const withSecret = await exchangeWith(() => json(BEARER), { secret: 's3cret' });
  await withSecret.run();
  const sent = withSecret.seen[0];
  const headers = new Headers(sent?.init?.headers);
  check(sent?.init?.method, 'POST', 'method');
  check(headers.get('content-type'), 'application/x-www-form-urlencoded', 'content type');
  check(headers.get('accept'), 'application/json', 'accept');
  check(
    new URLSearchParams(String(sent?.init?.body)).get('client_secret'),
    's3cret',
    'secret sent',
  );
  const without = await exchangeWith(() => json(BEARER));
  await without.run();
  check(
    new URLSearchParams(String(without.seen[0]?.init?.body)).get('client_secret'),
    null,
    'no secret',
  );
});

Deno.test('a refused exchange and a refused refresh are told apart', async () => {
  const exchange = await exchangeWith(() => json({}, 500));
  check(
    await rejection(exchange.run),
    `Token exchange failed at ${TOKEN_ENDPOINT} (HTTP 500)`,
    'exchange',
  );
  const { fetchFn } = routes({ [TOKEN_ENDPOINT]: () => json({}, 500) });
  check(
    await rejection(() =>
      refreshOAuthToken({
        issuer: ISSUER,
        resource: RESOURCE,
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: 'c',
        refreshToken: 'r',
        fetchFn,
      }),
    ),
    `Token refresh failed at ${TOKEN_ENDPOINT} (HTTP 500)`,
    'refresh',
  );
});

Deno.test('a token covers its resource origin and the path at or below it', () => {
  const covers = (resource: string, url: string) => tokenAudienceCovers(resource, new URL(url));
  check(covers('https://a.example/mcp', 'https://a.example/mcp'), true, 'the path itself');
  check(
    covers('https://a.example/mcp/', 'https://a.example/mcp'),
    true,
    'trailing slash on the resource',
  );
  check(covers('https://a.example/mcp', 'https://a.example/mcp/tools'), true, 'below it');
  check(
    covers('https://a.example/mcp', 'https://a.example/mcpx'),
    false,
    'a sibling that shares a prefix',
  );
  check(covers('https://a.example/mcp', 'https://a.example/other'), false, 'another path');
  check(
    covers('https://a.example', 'https://a.example/anything'),
    true,
    'a bare origin covers its paths',
  );
  check(covers('https://a.example/mcp', 'https://b.example/mcp'), false, 'another origin');
  check(covers('not a url', 'https://a.example/mcp'), false, 'an unparseable resource');
});

Deno.test('a scope-refusal progress record has its kind, slot and both scope lists', () => {
  const record = {
    kind: 'auth_scope_refused',
    slot: 'docs',
    requested: ['a'],
    declared: ['b'],
  };
  check(authScopeRefusedSchema.parse(record), record, 'round trip');
  for (const bad of [
    { ...record, kind: 'other' },
    { ...record, slot: 1 },
    { ...record, requested: 'a' },
    { kind: 'auth_scope_refused' },
  ]) {
    check(authScopeRefusedSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

Deno.test('only http is allowed on loopback, and a body-less miss at the metadata URL moves on', async () => {
  check(
    (await rejection(() => flowFor({ redirectUri: 'ftp://localhost/cb' }))).startsWith(
      'OAuth redirect_uri "ftp://localhost/cb" must be',
    ),
    true,
    'ftp on loopback',
  );
  const missing = routes({
    [AS_URL]: () => new Response(null, { status: 404 }),
    [`${ISSUER}/.well-known/openid-configuration`]: () => json(AS_METADATA),
  });
  check(
    (await discoverAuthServerMetadata(ISSUER, { fetchFn: missing.fetchFn })).issuer,
    ISSUER,
    'falls through to the OIDC URL',
  );
});

Deno.test('the authorization URL carries the flow parameters under their protocol names', async () => {
  const flow = await flowFor({ scopes: ['a'] });
  const params = new URL(flow.authorizationUrl).searchParams;
  check(params.get('response_type'), 'code', 'response_type');
  check(params.get('client_id'), 'client', 'client_id');
  check(params.get('redirect_uri'), REDIRECT, 'redirect_uri');
  check(params.get('code_challenge_method'), 'S256', 'code_challenge_method');
  check(params.get('resource'), RESOURCE, 'resource');
  check(params.get('scope'), 'a', 'scope');
  check((params.get('code_challenge') ?? '').length, 43, 'code_challenge is a SHA-256 digest');
  check(params.get('state'), flow.state, 'state');
});

Deno.test('a provider parameter may be added but not one the flow sets itself', async () => {
  check(
    new URL(
      (await flowFor({ authorizationParams: { prompt: 'consent' } })).authorizationUrl,
    ).searchParams.get('prompt'),
    'consent',
    'a provider parameter rides along',
  );
  for (const name of [
    'response_type',
    'client_id',
    'redirect_uri',
    'code_challenge',
    'code_challenge_method',
    'state',
    'resource',
    'scope',
  ]) {
    check(
      await rejection(() => flowFor({ authorizationParams: { [name]: 'x' } })),
      `OAuth authorization parameter "${name}" is set by the flow and cannot be passed`,
      name,
    );
  }
  check(
    await rejection(() => flowFor({ scopes: ['a b'] })),
    'OAuth scope "a b" is not a single RFC 6749 scope token',
    'a scope that is two tokens',
  );
});

Deno.test('a URL that is not https is refused under the name of the field that held it', async () => {
  const http = 'http://x.example';
  const named = (field: string) =>
    `OAuth ${field} "${http}" must be an https URL without a fragment`;
  check(
    await rejection(() =>
      flowFor({ preResolved: { ...PRE_RESOLVED, authorizationEndpoint: http } }),
    ),
    named('authorization_endpoint'),
    'authorization_endpoint',
  );
  check(await rejection(() => flowFor({ resourceServerUrl: http })), named('resource'), 'resource');
  check(
    await rejection(() => discoverAuthServerMetadata(http, { fetchFn: routes({}).fetchFn })),
    named('issuer'),
    'issuer',
  );
  check(
    await rejection(() => discoverResourceMetadata(http, { fetchFn: routes({}).fetchFn })),
    named('resource'),
    'resource metadata url',
  );
  for (const field of ['token_endpoint', 'registration_endpoint']) {
    check(
      await rejection(() =>
        discoverAuthServerMetadata(ISSUER, {
          fetchFn: routes({ [AS_URL]: () => json({ ...AS_METADATA, [field]: http }) }).fetchFn,
        }),
      ),
      named(field),
      field,
    );
  }
});

Deno.test('resource metadata returns its optional lists as given', async () => {
  const found = await discoverResourceMetadata(RESOURCE, {
    fetchFn: routes({
      [RS_URL]: () =>
        json({
          resource: RESOURCE,
          authorization_servers: [ISSUER],
          scopes_supported: ['a'],
          bearer_methods_supported: ['header'],
        }),
    }).fetchFn,
  });
  check(found?.scopes_supported, ['a'], 'scopes_supported');
  check(found?.bearer_methods_supported, ['header'], 'bearer_methods_supported');
  check(found?.authorization_servers, [ISSUER], 'authorization_servers');
});

Deno.test('a grant beyond the ask names every scope it added, in order', async () => {
  const { run } = await exchangeWith(() => json({ ...BEARER, scope: 'a x y' }), {
    flow: { scopes: ['a'] },
  });
  check(
    await rejection(run),
    `Token response from ${TOKEN_ENDPOINT} grants scopes that were not asked for: x, y`,
    'two beyond',
  );
});

Deno.test('a typed credential is built by the server, by auth type', async () => {
  const { credentialForSignInGate, credentialFromTypedSecret } = await import(
    '../../src/kernel/auth/typed-secret.ts'
  );
  const said = (body: () => unknown) => {
    try {
      body();
      return 'ok';
    } catch (err) {
      return err instanceof Error
        ? `${(err as { kind?: string }).kind}: ${err.message}`
        : String(err);
    }
  };
  check(
    credentialFromTypedSecret('bearer', '  tok  '),
    { type: 'bearer', token: 'tok' },
    'bearer, trimmed',
  );
  check(credentialFromTypedSecret('api_key', 'k'), { type: 'api_key', key: 'k' }, 'api key');
  for (const bad of ['', '   ', 5, null, undefined]) {
    check(
      said(() => credentialFromTypedSecret('bearer', bad)),
      'request: A typed credential must be a non-empty string',
      `secret ${JSON.stringify(bad)}`,
    );
  }
  check(
    said(() => credentialFromTypedSecret('oauth' as never, 'x')),
    "request: A 'oauth' sign-in takes no typed credential; the host's callback saves it",
    'oauth takes none',
  );
  check(
    said(() => credentialForSignInGate(undefined, 'x')),
    'request: a typed credential answers only a sign-in gate',
    'no sign-in gate',
  );
  check(
    credentialForSignInGate({ slot: 'main', authType: 'api_key' }, 'k'),
    { slot: 'main', credential: { type: 'api_key', key: 'k' } },
    'a sign-in gate',
  );
});
