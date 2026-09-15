import { z } from 'zod';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import type { ToolExecuteSettlement } from '../../src/kernel/tools/execute.ts';
import {
  executeRegisteredTool,
  parseMcpRpcResponse,
  registerTool,
  resetTools,
} from '../../src/kernel/tools/mod.ts';
import { buildHttpToolTarget } from '../../src/kernel/tools/remote.ts';
import type { Profile } from '../../src/kernel/types.ts';

const testProfile: Profile = {
  id: 'test-profile',
  type: 'text',
  identity: { handle: 'test-agent' },
  models: {
    'test-model': {
      protocol: 'geminiInteractions',
      provider: 'google',
      apiId: 'test-model-id',
      efforts: { normal: 'minimal' },
      maxOutputTokens: 1000,
      temperature: 0.5,
    },
  },
  tools: {
    allow: [
      'fetch_user_profile',
      'linear_issue',
      'private_internal_api',
      'local_mcp',
      'http_deny_probe',
    ],
  },
  inputs: { text: true },
  outputs: {},
};

Deno.test('Declarative HTTP Tool gates when credentials are missing and policy is pause', async () => {
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

  let settlement: ToolExecuteSettlement | undefined;
  while (true) {
    const next = await exec.next();
    if (next.done) {
      settlement = next.value;
      break;
    }
    events.push(next.value);
  }

  const gateEvent = events.find((e) => e.type === 'tool' && e.tool?.phase === 'gate');
  assertEquals(Boolean(gateEvent), true);
  assertEquals(gateEvent?.type === 'tool' ? gateEvent.tool?.gate?.kind : undefined, 'auth');
  assertEquals(
    gateEvent?.type === 'tool' ? gateEvent.tool?.gate?.authChallenge?.slot : undefined,
    'user_auth',
  );
  const preToolStage = events.find(
    (e) => e.type === 'stage' && e.stage === 'pre_tool' && e.callNotStarted === true,
  );
  assertEquals(Boolean(preToolStage), true);
  assertEquals(settlement?.gated?.kind, 'auth');
  assertEquals(settlement?.callNotStarted, true);
  assertEquals(settlement?.modelResult, undefined);
});

Deno.test('Declarative HTTP Tool preTool deny settles with modelResult + post_tool', async () => {
  resetTools();
  registerTool({
    name: 'http_deny_probe',
    description: 'HTTP tool denied by preTool',
    type: 'http',
    endpoint: 'https://api.example.com/x',
    method: 'GET',
    category: 'api',
    access: 'read-only',
    loadTier: 'T0',
    permission: 'auto',
    paths: ['*'],
    input: z.object({}),
    output: z.unknown(),
    preTool: () => ({ deny: { code: 'not_authorized', message: 'http denied' } }),
  });

  const events = [];
  const exec = executeRegisteredTool({
    profile: testProfile,
    name: 'http_deny_probe',
    input: {},
    callId: 'call_deny',
    ctx: {},
    stages: {
      handlers: [],
      step: 1,
      history: () => [],
      injectAllowed: false,
    },
  });

  let settlement: ToolExecuteSettlement | undefined;
  while (true) {
    const next = await exec.next();
    if (next.done) {
      settlement = next.value;
      break;
    }
    events.push(next.value);
  }

  assertEquals(settlement?.failure?.code, 'not_authorized');
  assertEquals(settlement?.callNotStarted, true);
  assertEquals(Boolean(settlement?.modelResult?.finding?.includes('not_authorized')), true);
  const postTool = events.find((e) => e.type === 'stage' && e.stage === 'post_tool');
  assertEquals(Boolean(postTool), true);
  assertEquals(postTool?.type === 'stage' ? postTool.callNotStarted : undefined, true);
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

  let settlement: ToolExecuteSettlement | undefined;
  while (true) {
    const next = await exec.next();
    if (next.done) {
      settlement = next.value;
      break;
    }
  }

  assertEquals(
    Boolean(settlement?.modelResult?.finding?.includes('Authentication required')),
    true,
  );
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

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = input.toString();
    const headers = new Headers(init?.headers);
    authHeader = headers.get('authorization') ?? '';
    return Promise.resolve(new Response(JSON.stringify({ id: 'usr_123', name: 'Alice' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
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

    let settlement: ToolExecuteSettlement | undefined;
    while (true) {
      const next = await exec.next();
      if (next.done) {
        settlement = next.value;
        break;
      }
      events.push(next.value);
    }

    assertEquals(requestedUrl, 'https://api.example.com/users/usr_123?includeHistory=true');
    assertEquals(authHeader, 'Bearer valid-secret-token');
    assertEquals((settlement?.modelResult?.data as { name: string })?.name, 'Alice');

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

  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    receivedRpc = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    receivedHeaders = Object.fromEntries(headers.entries());

    // MCP JSON-RPC 2026-07-28 response
    return Promise.resolve(new Response(
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
    ));
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

    let settlement: ToolExecuteSettlement | undefined;
    while (true) {
      const next = await exec.next();
      if (next.done) {
        settlement = next.value;
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
    assertEquals(receivedHeaders.accept, 'application/json, text/event-stream');
    assertEquals(receivedHeaders['x-api-key'], 'lin_api_key_xyz');

    const data = settlement?.modelResult?.data as { issueId: string } | undefined;
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

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const urlStr = input.toString();
    const headers = new Headers(init?.headers);

    if (urlStr === 'https://auth.example.com/oauth/token') {
      return Promise.resolve(new Response(
        JSON.stringify({
          access_token: 'new-shiny-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    }

    if (urlStr === 'https://api.example.com/me') {
      if (headers.get('authorization') === 'Bearer new-shiny-access-token') {
        refreshedTokenUsedInToolCall = true;
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
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

Deno.test('buildHttpToolTarget maps path and query parameters', () => {
  const target = buildHttpToolTarget(
    'https://geocoding-api.open-meteo.com/v1/search?count=3',
    'GET',
    { name: 'Paris' },
    { queryParams: ['name'] },
  );
  assertEquals(target.url, 'https://geocoding-api.open-meteo.com/v1/search?count=3&name=Paris');
  assertEquals(target.body, undefined);

  const pathTarget = buildHttpToolTarget(
    'https://en.wikipedia.org/api/rest_v1/page/summary/{title}',
    'GET',
    { title: 'Paris' },
    { pathParams: ['title'] },
  );
  assertEquals(pathTarget.url, 'https://en.wikipedia.org/api/rest_v1/page/summary/Paris');
});

Deno.test('parseMcpRpcResponse extracts JSON-RPC result from SSE', () => {
  const sse = `: ping\n\nevent: message\ndata: {"method":"notifications/message","params":{"level":"info"},"jsonrpc":"2.0"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":9,"result":{"content":[{"type":"text","text":"ok"}]}}\n`;
  const parsed = parseMcpRpcResponse(sse);
  assertEquals(parsed.id, 9);
  assertEquals(parsed.result?.content?.[0]?.text, 'ok');
});

Deno.test('parseMcpRpcResponse parses plain JSON bodies', () => {
  const parsed = parseMcpRpcResponse('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
  const tools = parsed.result?.tools;
  assertEquals(Array.isArray(tools) && tools.length === 0, true);
});

function registerLinearMcpFixture() {
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
}

async function collectToolRun(name: string, input: unknown, callId: string) {
  const events = [];
  const exec = executeRegisteredTool({
    profile: testProfile,
    name,
    input,
    callId,
    ctx: {
      credentials: {
        linear_auth: { type: 'api_key', key: 'lin_api_key_xyz' },
      },
    },
  });
  let settlement: ToolExecuteSettlement | undefined;
  while (true) {
    const next = await exec.next();
    if (next.done) {
      settlement = next.value;
      break;
    }
    events.push(next.value);
  }
  return { events, settlement };
}

Deno.test('Remote MCP Tool reports invalid input and network blocks', async () => {
  registerLinearMcpFixture();
  const invalid = await collectToolRun('linear_issue', { title: 1 }, 'call_mcp_invalid');
  assertEquals(
    invalid.events.find((e) => e.tool?.phase === 'error')?.tool?.failure?.code,
    'invalid_input',
  );

  resetTools();
  registerTool({
    name: 'local_mcp',
    description: 'blocked',
    type: 'mcp',
    serverUrl: 'https://127.0.0.1:9/mcp',
    mcpToolName: 'noop',
    category: 'workflow',
    access: 'read-only',
    loadTier: 'T0',
    permission: 'auto',
    paths: ['*'],
    input: z.object({}),
    output: z.unknown(),
  });
  const events = [];
  for await (const ev of executeRegisteredTool({
    profile: testProfile,
    name: 'local_mcp',
    input: {},
    callId: 'call_mcp_blocked',
    ctx: {},
  })) {
    events.push(ev);
  }
  assertEquals(
    events.find((e) => e.tool?.phase === 'error')?.tool?.failure?.code,
    'network_blocked',
  );
});

Deno.test('Remote MCP Tool surfaces RPC, tool, HTTP, and schema failures', async () => {
  registerLinearMcpFixture();
  const originalFetch = globalThis.fetch;
  const input = { title: 'Bug', description: 'x' };

  try {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32000, message: 'boom', data: { retry: false } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ))) as typeof fetch;
    const rpcErr = await collectToolRun('linear_issue', input, 'call_mcp_rpc_err');
    assertEquals(
      rpcErr.events.find((e) => e.tool?.phase === 'error')?.tool?.failure?.code,
      'mcp_rpc_error_-32000',
    );

    globalThis.fetch = (() =>
      Promise.resolve(new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { isError: true, content: [{ type: 'text', text: 'tool blew up' }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ))) as typeof fetch;
    const toolErr = await collectToolRun('linear_issue', input, 'call_mcp_tool_err');
    assertEquals(
      toolErr.events.find((e) => e.tool?.phase === 'error')?.tool?.failure?.code,
      'mcp_tool_execution_failed',
    );

    globalThis.fetch = (() => Promise.resolve(new Response('nope', { status: 500 }))) as typeof fetch;
    const httpErr = await collectToolRun('linear_issue', input, 'call_mcp_http_err');
    assertEquals(
      httpErr.events.find((e) => e.tool?.phase === 'error')?.tool?.failure?.code,
      'mcp_http_500',
    );

    globalThis.fetch = (() =>
      Promise.resolve(new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: '{"wrong":true}' }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ))) as typeof fetch;
    const schemaErr = await collectToolRun('linear_issue', input, 'call_mcp_schema_err');
    assertEquals(
      schemaErr.events.find((e) => e.tool?.phase === 'error')?.tool?.failure?.code,
      'invalid_output',
    );

    globalThis.fetch = (() => {
      throw new Error('socket reset');
    }) as typeof fetch;
    const netErr = await collectToolRun('linear_issue', input, 'call_mcp_net_err');
    assertEquals(
      netErr.events.find((e) => e.tool?.phase === 'error')?.tool?.failure?.code,
      'network_error',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('Remote MCP Tool retries unsupported protocol versions then succeeds', async () => {
  registerLinearMcpFixture();
  const originalFetch = globalThis.fetch;
  let attempt = 0;
  globalThis.fetch = ((_input, _init) => {
    attempt += 1;
    if (attempt === 1) {
      return Promise.resolve(new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32600, message: 'Unsupported protocol version' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    }
    return Promise.resolve(new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ issueId: 'LIN-202', url: 'https://linear.app/issue/LIN-202' }),
            },
          ],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
  }) as typeof fetch;

  try {
    const { settlement } = await collectToolRun(
      'linear_issue',
      { title: 'Retry', description: 'protocol' },
      'call_mcp_retry',
    );
    assertEquals(attempt >= 2, true);
    assertEquals(
      (settlement?.modelResult?.data as { issueId?: string } | undefined)?.issueId,
      'LIN-202',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('Remote MCP Tool retries HTTP 400 unsupported protocol versions then succeeds', async () => {
  registerLinearMcpFixture();
  const originalFetch = globalThis.fetch;
  let attempt = 0;
  let secondProtocol: string | null = null;
  globalThis.fetch = ((_input, init) => {
    attempt += 1;
    const headers = new Headers(init?.headers);
    if (attempt === 1) {
      return Promise.resolve(new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: {
            code: -32600,
            message:
              'Bad Request: Unsupported protocol version: 2026-07-28. Supported versions: 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25',
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ));
    }
    secondProtocol = headers.get('mcp-protocol-version');
    return Promise.resolve(new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ issueId: 'LIN-400', url: 'https://linear.app/issue/LIN-400' }),
            },
          ],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
  }) as typeof fetch;

  try {
    const { settlement } = await collectToolRun(
      'linear_issue',
      { title: 'HTTP 400 retry', description: 'protocol' },
      'call_mcp_http_400_retry',
    );
    assertEquals(attempt >= 2, true);
    assertEquals(secondProtocol, '2025-11-25');
    assertEquals(
      (settlement?.modelResult?.data as { issueId?: string } | undefined)?.issueId,
      'LIN-400',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
