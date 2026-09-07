import { z } from 'zod';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { executeRegisteredTool, registerTool, resetTools } from '../../src/kernel/tools/mod.ts';
import type { ModelToolResult } from '../../src/kernel/tools/types.ts';
import type { Profile } from '../../src/kernel/types.ts';

const testProfile: Profile = {
  id: 'test-profile',
  type: 'text',
  identity: { handle: 'test-agent' },
  model: {
    protocol: 'geminiInteractions',
    provider: 'google',
    allow: ['test-model'],
    config: {
      'test-model': {
        apiId: 'test-model-id',
        maxOutputTokens: 1000,
        temperature: 0.5,
      },
    },
  },
  tools: {
    allow: ['fetch_user_profile', 'linear_issue', 'private_internal_api'],
  },
  inputs: { text: true },
  outputs: {},
};

Deno.test('Declarative HTTP Tool pauses when credentials are missing and policy is pause', async () => {
  resetTools();
  registerTool({
    name: 'fetch_user_profile',
    description: 'Fetch user profile by id',
    type: 'http',
    endpoint: 'https://api.example.com/users/{id}',
    method: 'GET',
    category: 'api',
    access: 'read-only',
    loadTier: 'T0',
    permission: 'auto',
    paths: ['*'],
    auth: {
      slot: 'user_auth',
      type: 'bearer',
      onUnauthenticated: 'pause',
    },
    input: z.object({ id: z.string() }),
    output: z.object({ name: z.string() }),
    mapping: {
      pathParams: ['id'],
    },
  });

  const events = [];
  const exec = executeRegisteredTool({
    profile: testProfile,
    name: 'fetch_user_profile',
    input: { id: 'usr_123' },
    callId: 'call_1',
    ctx: {},
  });

  for await (const ev of exec) {
    events.push(ev);
  }

  const pauseEvent = events.find((e) => e.tool?.phase === 'pause');
  assertEquals(Boolean(pauseEvent), true);
  assertEquals(pauseEvent?.tool?.pause?.kind, 'auth');
  assertEquals(pauseEvent?.tool?.pause?.authChallenge?.slot, 'user_auth');
});

Deno.test('Declarative HTTP Tool reports error finding when policy is report_to_model', async () => {
  resetTools();
  registerTool({
    name: 'fetch_user_profile',
    description: 'Fetch user profile by id',
    type: 'http',
    endpoint: 'https://api.example.com/users/{id}',
    method: 'GET',
    category: 'api',
    access: 'read-only',
    loadTier: 'T0',
    permission: 'auto',
    paths: ['*'],
    auth: {
      slot: 'user_auth',
      type: 'bearer',
      onUnauthenticated: 'report_to_model',
    },
    input: z.object({ id: z.string() }),
    output: z.object({ name: z.string() }),
    mapping: {
      pathParams: ['id'],
    },
  });

  const exec = executeRegisteredTool({
    profile: testProfile,
    name: 'fetch_user_profile',
    input: { id: 'usr_123' },
    callId: 'call_1',
    ctx: {},
  });

  let result: ModelToolResult | undefined;
  while (true) {
    const next = await exec.next();
    if (next.done) {
      result = next.value;
      break;
    }
  }

  assertEquals(Boolean(result?.finding?.includes('Authentication required')), true);
});

Deno.test('Declarative HTTP Tool triggers SSRF guardrail on private IP without permission', async () => {
  resetTools();
  registerTool({
    name: 'private_internal_api',
    description: 'Internal private endpoint',
    type: 'http',
    endpoint: 'https://169.254.169.254/latest/meta-data',
    method: 'GET',
    category: 'api',
    access: 'read-only',
    loadTier: 'T0',
    permission: 'auto',
    paths: ['*'],
    input: z.object({}),
    output: z.unknown(),
  });

  const events = [];
  const exec = executeRegisteredTool({
    profile: testProfile,
    name: 'private_internal_api',
    input: {},
    callId: 'call_1',
    ctx: {},
  });

  for await (const ev of exec) {
    events.push(ev);
  }

  const errorEvent = events.find((e) => e.tool?.phase === 'error');
  assertEquals(errorEvent?.tool?.failure?.code, 'network_blocked');
  assertEquals(errorEvent?.tool?.failure?.message.includes('blocked by network guardrail'), true);
});

Deno.test('Declarative HTTP Tool executes successfully with auth header and param mapping', async () => {
  resetTools();
  registerTool({
    name: 'fetch_user_profile',
    description: 'Fetch user profile by id',
    type: 'http',
    endpoint: 'https://api.example.com/users/{id}',
    method: 'GET',
    category: 'api',
    access: 'read-only',
    loadTier: 'T0',
    permission: 'auto',
    paths: ['*'],
    auth: {
      slot: 'user_auth',
      type: 'bearer',
    },
    input: z.object({ id: z.string(), includeHistory: z.boolean().optional() }),
    output: z.object({ id: z.string(), name: z.string() }),
    mapping: {
      pathParams: ['id'],
      queryParams: ['includeHistory'],
    },
  });

  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let authHeader = '';

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = input.toString();
    const headers = new Headers(init?.headers);
    authHeader = headers.get('authorization') ?? '';
    return new Response(JSON.stringify({ id: 'usr_123', name: 'Alice' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const events = [];
    const exec = executeRegisteredTool({
      profile: testProfile,
      name: 'fetch_user_profile',
      input: { id: 'usr_123', includeHistory: true },
      callId: 'call_success_1',
      ctx: {
        credentials: {
          user_auth: {
            type: 'bearer',
            token: 'valid-secret-token',
          },
        },
      },
    });

    let result: ModelToolResult | undefined;
    while (true) {
      const next = await exec.next();
      if (next.done) {
        result = next.value;
        break;
      }
      events.push(next.value);
    }

    assertEquals(requestedUrl, 'https://api.example.com/users/usr_123?includeHistory=true');
    assertEquals(authHeader, 'Bearer valid-secret-token');
    assertEquals((result?.data as { name: string })?.name, 'Alice');

    const completeEvent = events.find((e) => e.tool?.phase === 'complete');
    assertEquals(Boolean(completeEvent), true);
    assertEquals((completeEvent?.tool?.output as { id: string })?.id, 'usr_123');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('Declarative HTTP Tool fails when required path param is missing', async () => {
  resetTools();
  registerTool({
    name: 'fetch_user_profile',
    description: 'Fetch user profile',
    type: 'http',
    endpoint: 'https://api.example.com/users/{id}',
    method: 'GET',
    category: 'api',
    access: 'read-only',
    loadTier: 'T0',
    permission: 'auto',
    paths: ['*'],
    input: z.object({ id: z.string().optional() }),
    output: z.unknown(),
    mapping: {
      pathParams: ['id'],
    },
  });

  const events = [];
  const exec = executeRegisteredTool({
    profile: testProfile,
    name: 'fetch_user_profile',
    input: {},
    callId: 'call_missing_param',
    ctx: {},
  });

  for await (const ev of exec) {
    events.push(ev);
  }

  const err = events.find((e) => e.tool?.phase === 'error');
  assertEquals(err?.tool?.failure?.code, 'invalid_input');
  assertEquals(err?.tool?.failure?.message.includes('Missing required path parameter'), true);
});

Deno.test('Remote MCP Tool executes successfully per 2026-07-28 spec', async () => {
  resetTools();
  registerTool({
    name: 'linear_issue',
    description: 'Create linear issue via MCP',
    type: 'mcp',
    serverUrl: 'https://mcp.linear.app/sse',
    mcpToolName: 'create_issue',
    category: 'workflow',
    access: 'read-write',
    loadTier: 'T0',
    permission: 'auto',
    paths: ['*'],
    auth: {
      slot: 'linear_auth',
      type: 'api_key',
      headerName: 'X-API-Key',
    },
    input: z.object({ title: z.string(), description: z.string() }),
    output: z.object({ issueId: z.string(), url: z.string() }),
  });

  const originalFetch = globalThis.fetch;
  let receivedRpc: unknown;
  let receivedHeaders: Record<string, string> = {};

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    receivedRpc = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    receivedHeaders = Object.fromEntries(headers.entries());

    // MCP JSON-RPC 2026-07-28 response
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: (receivedRpc as { id: unknown }).id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ issueId: 'LIN-101', url: 'https://linear.app/issue/LIN-101' }),
            },
          ],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const events = [];
    const exec = executeRegisteredTool({
      profile: testProfile,
      name: 'linear_issue',
      input: { title: 'Bug in runner', description: 'Investigate SSRF' },
      callId: 'call_mcp_1',
      ctx: {
        credentials: {
          linear_auth: {
            type: 'api_key',
            key: 'lin_api_key_xyz',
          },
        },
      },
    });

    let result: ModelToolResult | undefined;
    while (true) {
      const next = await exec.next();
      if (next.done) {
        result = next.value;
        break;
      }
      events.push(next.value);
    }

    assertEquals((receivedRpc as { method: string }).method, 'tools/call');
    assertEquals((receivedRpc as { params: { name: string } }).params.name, 'create_issue');
    assertEquals(
      (receivedRpc as { params: { _meta: { 'io.modelcontextprotocol/protocolVersion': string } } })
        .params._meta['io.modelcontextprotocol/protocolVersion'],
      '2026-07-28',
    );
    assertEquals(receivedHeaders['mcp-protocol-version'], '2026-07-28');
    assertEquals(receivedHeaders['x-api-key'], 'lin_api_key_xyz');

    const data = result?.data as { issueId: string } | undefined;
    assertEquals(data?.issueId, 'LIN-101');
    const completeEvent = events.find((e) => e.tool?.phase === 'complete');
    assertEquals(Boolean(completeEvent), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('Proactive OAuth token refresh during tool execution emits progress and updates ctx', async () => {
  resetTools();
  registerTool({
    name: 'fetch_user_profile',
    description: 'Fetch user profile',
    type: 'http',
    endpoint: 'https://api.example.com/me',
    method: 'GET',
    category: 'api',
    access: 'read-only',
    loadTier: 'T0',
    permission: 'auto',
    paths: ['*'],
    auth: {
      slot: 'oauth_slot',
      type: 'oauth2',
    },
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
  });

  const originalFetch = globalThis.fetch;
  let refreshedTokenUsedInToolCall = false;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const urlStr = input.toString();
    const headers = new Headers(init?.headers);

    if (urlStr === 'https://auth.example.com/oauth/token') {
      return new Response(
        JSON.stringify({
          access_token: 'new-shiny-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (urlStr === 'https://api.example.com/me') {
      if (headers.get('authorization') === 'Bearer new-shiny-access-token') {
        refreshedTokenUsedInToolCall = true;
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected request to ${urlStr}`);
  }) as typeof fetch;

  try {
    const events = [];
    const ctxCredentials = {
      oauth_slot: {
        type: 'oauth2' as const,
        issuer: 'https://auth.example.com',
        accessToken: 'expired-access-token',
        refreshToken: 'valid-refresh-token',
        expiresAt: Date.now() - 5000, // expired 5 seconds ago
        tokenEndpoint: 'https://auth.example.com/oauth/token',
        clientId: 'client-abc',
      },
    };

    const exec = executeRegisteredTool({
      profile: testProfile,
      name: 'fetch_user_profile',
      input: {},
      callId: 'call_oauth_refresh',
      ctx: {
        credentials: ctxCredentials,
      },
    });

    for await (const ev of exec) {
      events.push(ev);
    }

    // Check that progress event with kind auth_token_refreshed was emitted
    const progressEvent = events.find(
      (e) =>
        e.tool?.phase === 'progress' &&
        (e.tool?.data as { kind?: string })?.kind === 'auth_token_refreshed',
    );
    assertEquals(Boolean(progressEvent), true);
    assertEquals(refreshedTokenUsedInToolCall, true);

    // Context credentials mutated in-memory
    assertEquals(ctxCredentials.oauth_slot.accessToken, 'new-shiny-access-token');
    assertEquals(ctxCredentials.oauth_slot.refreshToken, 'new-refresh-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
