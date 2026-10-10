import { z } from 'zod';
import { lexiconText } from '../../src/guardrails/lexicon.ts';
import { TheoremError } from '../../src/guardrails/theorem-error.ts';
import { memoryCredentialSource } from '../../src/kernel/auth/credential-source.ts';
import type { ToolCredential } from '../../src/kernel/auth/types.ts';
import { registerTool, resetTools } from '../../src/kernel/default-scope.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { executeRegisteredTool } from '../../src/kernel/tools/mod.ts';
import type { ToolAuthConfig, ToolContext } from '../../src/kernel/tools/types.ts';
import type { Profile } from '../../src/kernel/types.ts';
import { toolEventsOf } from '../fixtures/events.ts';

const TOKEN = 'sheet-token-sentinel';
const RESOLVE = () => Promise.resolve(['93.184.216.34']);
const profile: Profile = {
  id: 'function-auth-profile',
  type: 'text',
  identity: { handle: 'test-agent' },
  models: {
    'test-model': {
      provider: 'google',
      apiId: 'test-model-id',
      efforts: { normal: 'minimal' },
      maxOutputTokens: 1000,
      temperature: 0.5,
    },
  },
  defaultModel: 'test-model',
  tools: { allow: ['read_sheet'] },
  inputs: { text: true },
  outputs: {},
};
/** A function tool that reads one URL with its signed-in fetch and returns the body. */
function registerSheetTool(
  auth: Omit<ToolAuthConfig, 'service'>,
  url = 'https://sheets.example.com/v4/s/1',
) {
  resetTools();
  const seen: {
    ctx?: ToolContext;
  } = {};
  registerTool({
    name: 'read_sheet',
    description: 'Read a spreadsheet',
    type: 'function',
    category: 'api',
    access: 'read-only',
    loadTier: 'T0',
    permission: 'auto',
    paths: ['*'],
    auth: { ...auth, service: 'Sheets' },
    input: z.object({}),
    output: z.object({ body: z.string() }),
    handler: async (_input, ctx) => {
      seen.ctx = ctx;
      if (!ctx.signedInFetch) throw new Error('no signed-in fetch');
      const response = await ctx.signedInFetch(url);
      return { body: await response.text() };
    },
  });
  return seen;
}
async function run(credentials: Readonly<Record<string, ToolCredential>>) {
  const events = [];
  for await (const ev of executeRegisteredTool({
    tools: defaultKernelScope.tools,
    profile,
    name: 'read_sheet',
    input: {},
    callId: 'call_sheet',
    ctx: { credentials: memoryCredentialSource(credentials), resolveHost: RESOLVE },
  })) {
    events.push(ev);
  }
  return events;
}
async function withFetch<T>(fetchFn: typeof fetch, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchFn;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}
function answering(status: number, text: string, headers: Record<string, string> = {}) {
  const sent: {
    url: string;
    authorization: string | null;
  }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    sent.push({
      url: input.toString(),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return Promise.resolve(new Response(text, { status, headers }));
  };
  return { fetchFn, sent };
}
const BEARER = { sheets: { type: 'bearer', token: TOKEN } } satisfies Record<
  string,
  ToolCredential
>;
Deno.test('a function tool that signs in gates, naming its service, when the slot is empty', async () => {
  const seen = registerSheetTool({ slot: 'sheets', type: 'bearer' });
  const events = await run({});
  const [gate] = toolEventsOf(events, 'gate');
  assertEquals(gate?.gate.kind === 'auth' ? gate.gate.authChallenge.service : '', 'Sheets');
  assertEquals(seen.ctx, undefined);
});
Deno.test('a function tool that signs in tells the model when its policy says so', async () => {
  registerSheetTool({ slot: 'sheets', type: 'bearer', onUnauthenticated: 'report_to_model' });
  const events = await run({});
  assertEquals(toolEventsOf(events, 'gate').length, 0);
  assertEquals(toolEventsOf(events, 'complete').length, 1);
});
Deno.test('the handler requests with the credential but never holds it, and an echo is omitted', async () => {
  const seen = registerSheetTool({ slot: 'sheets', type: 'bearer' });
  const { fetchFn, sent } = answering(200, `you sent ${TOKEN}`);
  const events = await withFetch(fetchFn, () => run(BEARER));
  assertEquals(sent, [
    { url: 'https://sheets.example.com/v4/s/1', authorization: `Bearer ${TOKEN}` },
  ]);
  assertEquals(JSON.stringify(seen.ctx ?? {}).includes(TOKEN), false);
  assertEquals(JSON.stringify(events).includes(TOKEN), false);
  assertEquals(toolEventsOf(events, 'complete').length, 1);
});
Deno.test('a credential the service refuses asks a function tool for a new sign-in', async () => {
  registerSheetTool({ slot: 'sheets', type: 'bearer', scopes: ['read', 'write'] });
  for (const [status, challenge] of [
    [401, 'Bearer error="invalid_token"'],
    [403, 'Bearer error="insufficient_scope", scope="write"'],
  ] as const) {
    const { fetchFn } = answering(status, 'refused', { 'WWW-Authenticate': challenge });
    const events = await withFetch(fetchFn, () => run(BEARER));
    const [gate] = toolEventsOf(events, 'gate');
    assertEquals(gate?.gate.kind === 'auth' ? gate.gate.authChallenge.service : '', 'Sheets');
    assertEquals(toolEventsOf(events, 'error').length, 0);
  }
});
Deno.test('a function tool asked for scopes it never declared fails without a sign-in', async () => {
  registerSheetTool({ slot: 'sheets', type: 'bearer', scopes: ['read'] });
  const { fetchFn } = answering(403, 'refused', {
    'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="admin"',
  });
  const events = await withFetch(fetchFn, () => run(BEARER));
  assertEquals(toolEventsOf(events, 'gate').length, 0);
  const [failed] = toolEventsOf(events, 'error');
  assertEquals(failed?.failure?.code, 'out_of_scope');
  assertEquals(
    failed?.failure?.message,
    lexiconText('sign_in.out_of_scope', { service: 'Sheets' }),
  );
});
Deno.test('a 403 that asks for no sign-in reaches the handler as a response', async () => {
  registerSheetTool({ slot: 'sheets', type: 'bearer' });
  const { fetchFn } = answering(403, 'not shared with you');
  const events = await withFetch(fetchFn, () => run(BEARER));
  assertEquals(toolEventsOf(events, 'gate').length, 0);
  assertEquals(toolEventsOf(events, 'complete').length, 1);
});
Deno.test('an OAuth token goes only to the resource it was issued for', async () => {
  registerSheetTool({ slot: 'sheets', type: 'oauth2' }, 'https://elsewhere.example.com/x');
  const { fetchFn, sent } = answering(200, 'ok');
  const events = await withFetch(fetchFn, () =>
    run({
      sheets: {
        type: 'oauth2',
        issuer: 'https://auth.example.com',
        resource: 'https://sheets.example.com',
        accessToken: TOKEN,
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'client',
        expiresAt: Date.now() + 3600000,
      },
    }),
  );
  assertEquals(sent.length, 0);
  assertEquals(toolEventsOf(events, 'error')[0]?.failure?.code, 'handler_error');
});
Deno.test('a function tool that signs in must name its service', () => {
  resetTools();
  assertThrows(
    () =>
      registerTool({
        name: 'read_sheet',
        description: 'Read a spreadsheet',
        type: 'function',
        category: 'api',
        access: 'read-only',
        loadTier: 'T0',
        permission: 'auto',
        paths: ['*'],
        auth: { slot: 'sheets', type: 'bearer', service: ' ' },
        input: z.object({}),
        output: z.object({ body: z.string() }),
        handler: () => ({ body: '' }),
      }),
    TheoremError,
    'names no service',
  );
});
