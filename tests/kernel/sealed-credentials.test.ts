import { z } from 'zod';
import { TheoremError } from '../../src/guardrails/error.ts';
import {
  type CredentialSource,
  memoryCredentialSource,
  type SealedCredentialSource,
  type ToolCredentialSource,
} from '../../src/kernel/auth/credential-source.ts';
import type { ToolCredential } from '../../src/kernel/auth/types.ts';
import { assertEquals, assertRejects } from '../../src/kernel/engine/assert.ts';
import type { KernelScope } from '../../src/kernel/scope.ts';
import { mcpSessionKey } from '../../src/kernel/tools/mcp-sessions.ts';
import { executeRegisteredTool, sealedCredentialHost } from '../../src/kernel/tools/mod.ts';
import type { ToolDefinitionInput } from '../../src/kernel/tools/types.ts';
import type { Profile, TurnEvent } from '../../src/kernel/types.ts';
import { toolEventsOf } from '../fixtures/events.ts';
import { createTestKernelScope } from '../fixtures/provider-scope.ts';

const KEY = 'sealed-key-sentinel';
const RESOLVE = () => Promise.resolve(['93.184.216.34']);
const RESOURCE = 'https://api.weather.example/';
const BEARER_KEY: ToolCredential = { type: 'bearer', token: KEY };

const profile: Profile = {
  id: 'sealed',
  type: 'text',
  identity: { handle: 'sealed' },
  models: { m: { protocol: 'openRouterOpenAi', provider: 'openrouter', apiId: 'test' } },
  defaultModel: 'm',
  tools: { allow: ['weather'] },
  inputs: { text: true },
  outputs: {},
};

const AUTH = { slot: 'weather', service: 'Weather', type: 'bearer' } satisfies Pick<
  NonNullable<Extract<ToolDefinitionInput, { type: 'http' }>['auth']>,
  'slot' | 'service' | 'type'
>;

const BASE = {
  name: 'weather',
  description: 'Weather for a city',
  category: 'api',
  access: 'read-only',
  loadTier: 'T0',
  permission: 'auto',
  paths: ['*'],
  input: z.object({ city: z.string() }),
  output: z.object({ temp: z.number() }),
  auth: AUTH,
} satisfies Partial<ToolDefinitionInput>;

const HTTP_TOOL: ToolDefinitionInput = {
  ...BASE,
  type: 'http',
  endpoint: 'https://api.weather.example/v1/now',
  method: 'GET',
  mapping: { queryParams: ['city'] },
};

const MCP_TOOL: ToolDefinitionInput = {
  ...BASE,
  type: 'mcp',
  serverUrl: 'https://api.weather.example/mcp',
  mcpToolName: 'now',
};

const FUNCTION_TOOL: ToolDefinitionInput = {
  ...BASE,
  type: 'function',
  handler: async (_input, ctx) => {
    if (!ctx.signedInFetch) throw new Error('no signed-in fetch');
    const response = await ctx.signedInFetch('https://api.weather.example/v1/now?city=Oslo');
    if (!response.ok) throw new Error(`weather said ${await response.text()}`);
    return z.object({ temp: z.number() }).parse(await response.json());
  },
};

const TOOLS = [HTTP_TOOL, MCP_TOOL, FUNCTION_TOOL];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const rpcId = (body: unknown): unknown =>
  typeof body === 'object' && body !== null && 'id' in body ? body.id : null;

/** A weather service that answers each tool kind; `fail` answers every request instead. */
function weather(fail?: () => Response) {
  const sent: { url: URL; authorization: string | null }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const url = new URL(input.toString());
    sent.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    if (fail) return Promise.resolve(fail());
    if (url.pathname === '/mcp') {
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      return Promise.resolve(
        json({
          jsonrpc: '2.0',
          id: rpcId(body),
          result: { content: [{ type: 'text', text: JSON.stringify({ temp: 2 }) }] },
        }),
      );
    }
    return Promise.resolve(json({ temp: 4 }));
  };
  return { fetchFn, sent };
}

/** A source that counts reads, to show what was never read. */
function watched(slots: Record<string, ToolCredential>): {
  source: ToolCredentialSource;
  reads: string[];
} {
  const inner = memoryCredentialSource(slots);
  const reads: string[] = [];
  return {
    reads,
    source: {
      get: (slot) => {
        reads.push(slot);
        return inner.get(slot);
      },
      set: (slot, credential) => inner.set(slot, credential),
      delete: (slot) => inner.delete(slot),
    },
  };
}

function sealedOver(source: ToolCredentialSource, fetchFn: typeof fetch): SealedCredentialSource {
  return sealedCredentialHost({
    source,
    slots: { weather: { resource: RESOURCE } },
    resolveHost: RESOLVE,
    fetchFn,
  });
}

function scopeOf(def: ToolDefinitionInput): KernelScope {
  const scope = createTestKernelScope();
  scope.tools.register(def);
  return scope;
}

/**
 * Runs the tool with `credentials`. The run's own fetch refuses unless `ownFetch` is given, so
 * every request went through the sealed side.
 */
async function run(
  tool: ToolDefinitionInput,
  credentials: CredentialSource,
  ownFetch: typeof fetch = () => Promise.reject(new Error('the run sent a request itself')),
) {
  const original = globalThis.fetch;
  globalThis.fetch = ownFetch;
  try {
    const events: TurnEvent[] = [];
    const exec = executeRegisteredTool({
      tools: scopeOf(tool).tools,
      profile,
      name: 'weather',
      input: { city: 'Oslo' },
      callId: 'call-1',
      ctx: { credentials, resolveHost: RESOLVE },
    });
    for (;;) {
      const next = await exec.next();
      if (next.done) return { events, settlement: next.value };
      events.push(next.value);
    }
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test('a sealed source sends every tool kind with the key, and the run never holds it', async () => {
  for (const tool of TOOLS) {
    const { fetchFn, sent } = weather();
    const { events, settlement } = await run(
      tool,
      sealedOver(memoryCredentialSource({ weather: BEARER_KEY }), fetchFn),
    );
    assertEquals({ [tool.type]: settlement.failure }, { [tool.type]: undefined });
    assertEquals(sent.length > 0, true);
    for (const request of sent) assertEquals(request.authorization, `Bearer ${KEY}`);
    assertEquals(JSON.stringify({ events, settlement }).includes(KEY), false);
  }
});

Deno.test('a key the service echoes reaches the run omitted, for every tool kind', async () => {
  for (const tool of TOOLS) {
    const { fetchFn } = weather(() => json({ error: `bad key ${KEY}` }, 500));
    const { events, settlement } = await run(
      tool,
      sealedOver(memoryCredentialSource({ weather: BEARER_KEY }), fetchFn),
    );
    assertEquals(
      { [tool.type]: settlement.failure?.message.includes('[omitted - credential]') },
      { [tool.type]: true },
    );
    assertEquals(JSON.stringify({ events, settlement }).includes(KEY), false);
  }
});

Deno.test("a redirect off the slot's origin is followed by the run without the key, and never sent sealed again", async () => {
  const sealedSent: string[] = [];
  const sealedFetch: typeof fetch = (input) => {
    sealedSent.push(input.toString());
    return Promise.resolve(
      new Response(null, { status: 302, headers: { Location: 'https://mirror.example/v1/now' } }),
    );
  };
  const ownSent: { url: string; authorization: string | null }[] = [];
  const ownFetch: typeof fetch = (input, init) => {
    const url = input.toString();
    ownSent.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    return Promise.resolve(
      url.startsWith('https://mirror.example/')
        ? new Response(null, { status: 302, headers: { Location: `${RESOURCE}v1/back` } })
        : json({ temp: 6 }),
    );
  };
  const { settlement } = await run(
    HTTP_TOOL,
    sealedOver(memoryCredentialSource({ weather: BEARER_KEY }), sealedFetch),
    ownFetch,
  );
  assertEquals(settlement.failure, undefined);
  assertEquals(sealedSent, [`${RESOURCE}v1/now?city=Oslo`]);
  assertEquals(ownSent, [
    { url: 'https://mirror.example/v1/now', authorization: null },
    // Back on the slot's origin, but the key already left it once.
    { url: `${RESOURCE}v1/back`, authorization: null },
  ]);
});

Deno.test('a key the service refuses asks for a new sign-in, as a key the run holds does', async () => {
  for (const tool of TOOLS) {
    const { fetchFn } = weather(() => json({ error: 'unauthorized' }, 401));
    const { events } = await run(
      tool,
      sealedOver(memoryCredentialSource({ weather: BEARER_KEY }), fetchFn),
    );
    const [gate] = toolEventsOf(events, 'gate');
    assertEquals({ [tool.type]: gate?.gate.kind }, { [tool.type]: 'auth' });
  }
});

Deno.test('an empty sealed slot gates before anything is sent', async () => {
  const { fetchFn, sent } = weather();
  const { events, settlement } = await run(
    HTTP_TOOL,
    sealedOver(memoryCredentialSource(), fetchFn),
  );
  assertEquals(toolEventsOf(events, 'gate')[0]?.gate.kind, 'auth');
  assertEquals(settlement.callNotStarted, true);
  assertEquals(sent.length, 0);
});

Deno.test('the sealed side refuses a request outside the slot, before it reads the key', async () => {
  const { source, reads } = watched({ weather: BEARER_KEY });
  const { fetchFn, sent } = weather();
  const host = sealedOver(source, fetchFn);
  for (const url of [
    'https://evil.example/v1/now',
    'https://api.weather.example.evil.example/v1/now',
    'http://api.weather.example/v1/now',
  ]) {
    await assertRejects(
      () => host.send('weather', url, { method: 'GET', headers: {} }),
      TheoremError,
      'cannot be sent',
    );
  }
  await assertRejects(
    () => host.send('other', `${RESOURCE}v1/now`, { method: 'GET', headers: {} }),
    TheoremError,
    "No sealed slot 'other'",
  );
  assertEquals(reads, []);
  assertEquals(sent, []);
});

Deno.test('the sealed side sends an OAuth token only to the resource it was issued for', async () => {
  const token: ToolCredential = {
    type: 'oauth2',
    issuer: 'https://auth.weather.example',
    resource: 'https://api.weather.example/v1/',
    accessToken: KEY,
    tokenEndpoint: 'https://auth.weather.example/token',
    clientId: 'client',
    expiresAt: Date.now() + 3600000,
  };
  const { fetchFn, sent } = weather();
  const host = sealedOver(memoryCredentialSource({ weather: token }), fetchFn);
  await assertRejects(
    () => host.send('weather', `${RESOURCE}v2/now`, { method: 'GET', headers: {} }),
    TheoremError,
    'cannot be sent',
  );
  assertEquals(sent, []);
  const answer = await host.send('weather', `${RESOURCE}v1/now`, { method: 'GET', headers: {} });
  assertEquals(await answer.json(), { temp: 4 });
  assertEquals(sent[0]?.authorization, `Bearer ${KEY}`);
});

Deno.test('the sealed side omits a key split across pieces of the body, and in every header', async () => {
  const bytes = new TextEncoder().encode(`before ${KEY} middle ${KEY}`);
  const cuts = [3, 10, 11, 20, bytes.length - 2];
  const fetchFn: typeof fetch = () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let from = 0;
        for (const cut of [...cuts, bytes.length]) {
          controller.enqueue(bytes.slice(from, cut));
          from = cut;
        }
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(body, {
        status: 302,
        headers: {
          Location: `https://api.weather.example/v1/next?key=${KEY}`,
          'X-Echo': KEY,
          'Content-Length': String(bytes.length),
        },
      }),
    );
  };
  const host = sealedOver(memoryCredentialSource({ weather: BEARER_KEY }), fetchFn);
  const answer = await host.send('weather', `${RESOURCE}v1/now`, { method: 'GET', headers: {} });
  assertEquals(answer.status, 302);
  assertEquals(
    answer.headers.get('location'),
    'https://api.weather.example/v1/next?key=[omitted - credential]',
  );
  assertEquals(answer.headers.get('x-echo'), '[omitted - credential]');
  assertEquals(answer.headers.get('content-length'), null);
  assertEquals(await answer.text(), 'before [omitted - credential] middle [omitted - credential]');
});

Deno.test('the sealed side omits a key the service echoes escaped in JSON or encoded in a URL', async () => {
  const key = 'ab/c+d e"f';
  const forms = [
    'ab/c+d e"f',
    'ab/c+d e\\"f',
    'ab\\/c+d e\\"f',
    'ab%2Fc%2Bd%20e%22f',
    'ab%2fc%2bd%20e%22f',
    'ab%2Fc%2Bd+e%22f',
  ];
  const bytes = new TextEncoder().encode(forms.join(' | '));
  const fetchFn: typeof fetch = () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let from = 0; from < bytes.length; from += 7) {
          controller.enqueue(bytes.slice(from, from + 7));
        }
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(body, {
        status: 302,
        headers: { Location: `https://api.weather.example/v1/next?key=${encodeURIComponent(key)}` },
      }),
    );
  };
  const host = sealedOver(
    memoryCredentialSource({ weather: { type: 'bearer', token: key } }),
    fetchFn,
  );
  const answer = await host.send('weather', `${RESOURCE}v1/now`, { method: 'GET', headers: {} });
  assertEquals(
    answer.headers.get('location'),
    'https://api.weather.example/v1/next?key=[omitted - credential]',
  );
  assertEquals(await answer.text(), forms.map(() => '[omitted - credential]').join(' | '));
});
Deno.test('a sealed prepare refreshes an expired token on its own side and tells no secret', async () => {
  const expired: ToolCredential = {
    type: 'oauth2',
    issuer: 'https://auth.weather.example',
    resource: RESOURCE,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    tokenEndpoint: 'https://auth.weather.example/token',
    clientId: 'client',
    expiresAt: Date.now() - 1000,
  };
  const source = memoryCredentialSource({ weather: expired });
  const fetchFn: typeof fetch = () =>
    Promise.resolve(json({ access_token: KEY, token_type: 'Bearer', expires_in: 3600 }));
  const host = sealedOver(source, fetchFn);
  const ready = await host.prepare('weather');
  assertEquals(ready.state === 'ready' ? ready.refreshed : ready.state, true);
  assertEquals(JSON.stringify(ready).includes(KEY), false);
  assertEquals(JSON.stringify(ready).includes('old-refresh'), false);
  const stored = await source.get('weather');
  assertEquals(stored?.type === 'oauth2' ? stored.accessToken : stored?.type, KEY);
  assertEquals(
    await host.prepare('nothing-here').catch((err) => String(err)),
    "TheoremError: No sealed slot 'nothing-here'",
  );
});

Deno.test('a sealed host limits each refresh to its timeoutMs, and leaves its sends unlimited', async () => {
  const expired: ToolCredential = {
    type: 'oauth2',
    issuer: 'https://auth.weather.example',
    resource: RESOURCE,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    tokenEndpoint: 'https://auth.weather.example/token',
    clientId: 'client',
    expiresAt: Date.now() - 1000,
  };
  const signals: (AbortSignal | null | undefined)[] = [];
  const stalls: typeof fetch = (_input, init) => {
    signals.push(init?.signal);
    const signal = init?.signal;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason));
    });
  };
  const host = (fetchFn: typeof fetch, source: ToolCredentialSource) =>
    sealedCredentialHost({
      source,
      slots: { weather: { resource: RESOURCE } },
      resolveHost: RESOLVE,
      fetchFn,
      timeoutMs: 20,
    });
  const ready = await host(stalls, memoryCredentialSource({ weather: expired })).prepare('weather');
  assertEquals(ready.state === 'unusable' ? ready.reason : ready.state, 'refresh_failed');
  const sent: (AbortSignal | null | undefined)[] = [];
  const answers: typeof fetch = (_input, init) => {
    sent.push(init?.signal);
    return Promise.resolve(json({ temp: 20 }));
  };
  await host(answers, memoryCredentialSource({ weather: BEARER_KEY })).send(
    'weather',
    `${RESOURCE}v1/now`,
    { method: 'GET', headers: {} },
  );
  assertEquals({ refresh: signals.length, send: sent }, { refresh: 1, send: [undefined] });
});

Deno.test('a refresh the token server refuses says why without anything it was sent', async () => {
  const expired: ToolCredential = {
    type: 'oauth2',
    issuer: 'https://auth.weather.example',
    resource: RESOURCE,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    tokenEndpoint: 'https://auth.weather.example/token',
    clientId: 'client',
    expiresAt: Date.now() - 1000,
  };
  const source: ToolCredentialSource = {
    ...memoryCredentialSource({ weather: expired }),
    clientSecret: () => Promise.resolve('client-secret'),
  };
  const fetchFn: typeof fetch = () =>
    Promise.resolve(
      json(
        {
          error: 'invalid_grant',
          error_description: 'old-refresh from client-secret replaced old-access',
        },
        400,
      ),
    );
  const ready = await sealedOver(source, fetchFn).prepare('weather');
  assertEquals(ready.state === 'unusable' ? ready.reason : ready.state, 'refresh_failed');
  const detail = ready.state === 'unusable' ? (ready.detail ?? '') : '';
  assertEquals(detail.includes('invalid_grant'), true);
  for (const secret of ['old-refresh', 'client-secret', 'old-access']) {
    assertEquals({ [secret]: detail.includes(secret) }, { [secret]: false });
  }
});

Deno.test('a sealed side that throws or fails settles the call, and the turn goes on', async () => {
  const host = sealedOver(memoryCredentialSource({ weather: BEARER_KEY }), weather().fetchFn);
  const down = () => Promise.reject(new Error('keys worker down'));
  const crashes: Record<string, SealedCredentialSource> = {
    undeclared: sealedCredentialHost({
      source: memoryCredentialSource({ weather: BEARER_KEY }),
      slots: {},
      resolveHost: RESOLVE,
    }),
    prepare: { ...host, prepare: down },
  };
  for (const [name, source] of Object.entries(crashes)) {
    for (const tool of TOOLS) {
      const { events, settlement } = await run(tool, source);
      assertEquals(
        { [`${name} ${tool.type}`]: settlement.failure?.code },
        { [`${name} ${tool.type}`]: 'hook_failed' },
      );
      const crash = events.find((event) => event.type === 'hook_failed');
      assertEquals(crash?.type === 'hook_failed' ? [crash.hook, crash.callId] : undefined, [
        'credentials',
        'call-1',
      ]);
    }
  }
  for (const tool of TOOLS) {
    const { settlement } = await run(tool, { ...host, send: down });
    assertEquals({ [tool.type]: settlement.failure?.message }, { [tool.type]: 'keys worker down' });
  }
});

Deno.test('a source the run reads that throws fails the call as a crashed credentials hook', async () => {
  const expired: ToolCredential = {
    type: 'oauth2',
    issuer: 'https://auth.weather.example',
    resource: RESOURCE,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    tokenEndpoint: 'https://auth.weather.example/token',
    clientId: 'client',
    expiresAt: Date.now() - 1000,
  };
  const down = () => Promise.reject(new Error('database down'));
  const tokenServer: typeof fetch = () =>
    Promise.resolve(json({ access_token: KEY, token_type: 'Bearer', expires_in: 3600 }));
  const crashes: Record<string, ToolCredentialSource> = {
    get: { ...memoryCredentialSource(), get: down },
    set: { ...memoryCredentialSource({ weather: expired }), set: down },
    clientSecret: { ...memoryCredentialSource({ weather: expired }), clientSecret: down },
  };
  for (const [name, source] of Object.entries(crashes)) {
    const { events, settlement } = await run(HTTP_TOOL, source, tokenServer);
    assertEquals({ [name]: settlement.failure?.code }, { [name]: 'hook_failed' });
    const crash = events.find((event) => event.type === 'hook_failed');
    assertEquals(
      { [name]: crash?.type === 'hook_failed' ? crash.hook : undefined },
      { [name]: 'credentials' },
    );
  }
});

Deno.test('the sealed side keeps every Set-Cookie the service sends', async () => {
  const fetchFn: typeof fetch = () => {
    const headers = new Headers();
    headers.append('Set-Cookie', 'a=1');
    headers.append('Set-Cookie', `b=${KEY}`);
    return Promise.resolve(new Response('ok', { headers }));
  };
  const host = sealedOver(memoryCredentialSource({ weather: BEARER_KEY }), fetchFn);
  const answer = await host.send('weather', `${RESOURCE}v1/now`, { method: 'GET', headers: {} });
  assertEquals(answer.headers.getSetCookie(), ['a=1', 'b=[omitted - credential]']);
});

Deno.test('an empty sealed slot prepares as absent, and a key with no expiry is ready as it is', async () => {
  const host = sealedOver(memoryCredentialSource(), weather().fetchFn);
  assertEquals(await host.prepare('weather'), { state: 'absent' });
  const keyed = sealedOver(memoryCredentialSource({ weather: BEARER_KEY }), weather().fetchFn);
  const ready = await keyed.prepare('weather');
  assertEquals(
    ready.state === 'ready' ? { refreshed: ready.refreshed, resource: ready.resource } : ready,
    { refreshed: false, resource: RESOURCE },
  );
});

Deno.test('MCP sessions are kept per credential, so a new key never reuses an old session', async () => {
  const url = `${RESOURCE}mcp`;
  const first = await mcpSessionKey(url, {}, 'id-one');
  assertEquals(await mcpSessionKey(url, {}, 'id-one'), first);
  assertEquals((await mcpSessionKey(url, {}, 'id-two')) === first, false);
  assertEquals((await mcpSessionKey(url, {}, undefined)) === first, false);
});
