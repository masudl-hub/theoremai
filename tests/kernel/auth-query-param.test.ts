import { z } from 'zod';
import { memoryCredentialSource } from '../../src/kernel/auth/credential-source.ts';
import type { ToolCredential } from '../../src/kernel/auth/types.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import type { KernelScope } from '../../src/kernel/scope.ts';
import { executeRegisteredTool } from '../../src/kernel/tools/mod.ts';
import type { ToolAuthConfig, ToolDefinitionInput } from '../../src/kernel/tools/types.ts';
import type { Profile, TurnEvent } from '../../src/kernel/types.ts';
import { toolEventsOf } from '../fixtures/events.ts';
import { createTestKernelScope } from '../fixtures/provider-scope.ts';

const KEY = 'query-key-sentinel';
const RESOLVE = () => Promise.resolve(['93.184.216.34']);
const AUTH = { slot: 'weather', service: 'Weather', type: 'api_key', queryParam: 'appid' } as const;
const CREDENTIALS = { weather: { type: 'api_key', key: KEY } } satisfies Record<
  string,
  ToolCredential
>;

const profile: Profile = {
  id: 'query-key',
  type: 'text',
  identity: { handle: 'query-key' },
  models: { m: { protocol: 'openRouter', provider: 'openrouter', apiId: 'test' } },
  defaultModel: 'm',
  tools: { allow: ['weather'] },
  inputs: { text: true },
  outputs: {},
};

const BASE = {
  name: 'weather',
  description: 'Weather for a city',
  category: 'api',
  access: 'read-only',
  loadTier: 'T0',
  permission: 'auto',
  paths: ['*'] as string[],
  input: z.object({ city: z.string() }),
  output: z.object({ temp: z.number() }),
} as const;

function httpTool(auth: ToolAuthConfig = AUTH, queryParams = ['city']): ToolDefinitionInput {
  return {
    ...BASE,
    type: 'http',
    endpoint: 'https://api.weather.example/v1/now',
    method: 'GET',
    mapping: { queryParams },
    auth,
  } as ToolDefinitionInput;
}

function scopeOf(def: ToolDefinitionInput): KernelScope {
  const scope = createTestKernelScope();
  scope.tools.register(def);
  return scope;
}

/** Every request the tool sent: its URL and its headers. */
function serving(respond: (url: URL, body: unknown) => Response) {
  const sent: { url: URL; headers: Headers }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const url = new URL(input.toString());
    sent.push({ url, headers: new Headers(init?.headers) });
    return Promise.resolve(respond(url, init?.body ? JSON.parse(String(init.body)) : undefined));
  };
  return { fetchFn, sent };
}

async function run(
  scope: KernelScope,
  fetchFn: typeof fetch,
  credentials: Record<string, ToolCredential> = CREDENTIALS,
) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchFn;
  try {
    const events: TurnEvent[] = [];
    const exec = executeRegisteredTool({
      tools: scope.tools,
      profile,
      name: 'weather',
      input: { city: 'Oslo' },
      callId: 'call-1',
      ctx: { credentials: memoryCredentialSource(credentials), resolveHost: RESOLVE },
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.test('an http tool puts its API key in the query parameter it names, and in no header', async () => {
  const { fetchFn, sent } = serving(() => json({ temp: 4 }));
  const { settlement } = await run(scopeOf(httpTool()), fetchFn);
  assertEquals(settlement.outputRaw, { temp: 4 });
  assertEquals(sent.length, 1);
  assertEquals(sent[0]?.url.searchParams.get('appid'), KEY);
  assertEquals(sent[0]?.url.searchParams.get('city'), 'Oslo');
  assertEquals(sent[0]?.headers.get('authorization'), null);
});

Deno.test('a key in the query is omitted from what the service sends back', async () => {
  const { fetchFn } = serving((url) =>
    json({ error: `bad key ${url.searchParams.get('appid')}` }, 500),
  );
  const { events, settlement } = await run(scopeOf(httpTool()), fetchFn);
  assertEquals(settlement.failure?.message.includes('[omitted - credential]'), true);
  assertEquals(JSON.stringify({ events, settlement }).includes(KEY), false);
});

const MCP_TOOL = {
  ...BASE,
  type: 'mcp',
  serverUrl: 'https://mcp.weather.example/mcp',
  mcpToolName: 'now',
  auth: AUTH,
} as ToolDefinitionInput;

const FUNCTION_TOOL = {
  ...BASE,
  type: 'function',
  auth: AUTH,
  handler: async (_input, ctx) => {
    if (!ctx.signedInFetch) throw new Error('no signed-in fetch');
    const response = await ctx.signedInFetch('https://api.weather.example/v1/now?city=Oslo');
    return (await response.json()) as { temp: number };
  },
} as ToolDefinitionInput;

Deno.test('a refused key in the query asks for a new sign-in, as a refused header does', async () => {
  for (const tool of [httpTool(), MCP_TOOL, FUNCTION_TOOL]) {
    const { fetchFn } = serving(() => json({ error: 'unauthorized' }, 401));
    const { events } = await run(scopeOf(tool), fetchFn);
    const [gate] = toolEventsOf(events, 'gate');
    assertEquals({ [tool.type]: gate?.gate.kind }, { [tool.type]: 'auth' });
  }
});

Deno.test("a host's key that fails its call: refused, it fails as a call that started, with no gate", async () => {
  const failing = httpTool({ ...AUTH, onUnauthenticated: 'fail' });
  const { fetchFn, sent } = serving(() => json({ error: 'unauthorized' }, 401));
  const { events, settlement } = await run(scopeOf(failing), fetchFn);
  assertEquals(toolEventsOf(events, 'gate').length, 0);
  assertEquals(
    { code: settlement.failure?.code, kind: settlement.failure?.kind },
    { code: 'not_authorized', kind: 'auth' },
  );
  assertEquals(settlement.callNotStarted, undefined);
  assertEquals(sent.length, 1);
  assertEquals(JSON.stringify({ events, settlement }).includes(KEY), false);
});

Deno.test("a host's key that fails its call: missing, nothing is sent", async () => {
  const failing = httpTool({ ...AUTH, onUnauthenticated: 'fail' });
  const { fetchFn, sent } = serving(() => json({ temp: 4 }));
  const { events, settlement } = await run(scopeOf(failing), fetchFn, {});
  assertEquals(toolEventsOf(events, 'gate').length, 0);
  assertEquals(settlement.failure?.code, 'not_authorized');
  assertEquals(settlement.callNotStarted, true);
  assertEquals(sent.length, 0);
});

Deno.test('a function tool signed in by query sends the key on its signed-in fetch', async () => {
  const { fetchFn, sent } = serving(() => json({ temp: 7 }));
  const { settlement } = await run(scopeOf(FUNCTION_TOOL), fetchFn);
  assertEquals(settlement.outputRaw, { temp: 7 });
  assertEquals(sent[0]?.url.searchParams.get('appid'), KEY);
  assertEquals(sent[0]?.url.searchParams.get('city'), 'Oslo');
});

Deno.test('an mcp tool signed in by query sends the key on the server URL', async () => {
  const { fetchFn, sent } = serving((_url, body) =>
    json({
      jsonrpc: '2.0',
      id: (body as { id: unknown }).id,
      result: { content: [{ type: 'text', text: JSON.stringify({ temp: 2 }) }] },
    }),
  );
  const { settlement } = await run(scopeOf(MCP_TOOL), fetchFn);
  assertEquals(settlement.outputRaw, { temp: 2 });
  assertEquals(sent.length > 0, true);
  for (const request of sent) assertEquals(request.url.searchParams.get('appid'), KEY);
});

Deno.test('a key goes in the URL only from an API-key tool, in one named place', () => {
  const refused = (auth: ToolAuthConfig, queryParams?: string[], message = 'auth.queryParam') =>
    assertThrows(() => scopeOf(httpTool(auth, queryParams)), Error, message);
  refused({ ...AUTH, queryParam: ' ' }, undefined, 'is blank');
  refused({ ...AUTH, type: 'bearer' }, undefined, "'bearer' sign-in");
  refused({ ...AUTH, headerName: 'X-Key' }, undefined, 'one place');
  refused(AUTH, ['city', 'appid'], 'mapping.queryParams');
});
