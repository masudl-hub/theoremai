import { assertEquals, assertStringIncludes } from '@std/assert';
import { z } from 'zod';
import type { ToolExecuteSettlement } from '../../src/kernel/tools/execute.ts';
import { executeRegisteredTool } from '../../src/kernel/tools/mod.ts';
import type { Profile } from '../../src/kernel/types.ts';
import { forwardedFetch } from '../../studio/forwarded-fetch.ts';
import { createStudioDraftHandler } from '../../studio/server.ts';
import { createTestKernelScope } from '../fixtures/provider-scope.ts';

const SERVER = 'http://studio.test/api/studio';

const profile: Profile = {
  id: 'failing',
  type: 'text',
  identity: { handle: 'failing' },
  models: { m: { protocol: 'openRouterOpenAi', provider: 'openrouter', apiId: 'test' } },
  defaultModel: 'm',
  tools: { allow: ['search'] },
  inputs: { text: true },
  outputs: {},
  guardrails: { network: { allowPrivateNetworks: true } },
};

/** One MCP call at `serverUrl`, from a page whose every request outside the studio fails as `fail` says. */
async function failedCall(
  serverUrl: string,
  fail: (url: string) => Promise<Response>,
): Promise<ToolExecuteSettlement> {
  const scope = createTestKernelScope();
  scope.tools.register({
    name: 'search',
    description: 'Search the web',
    type: 'mcp',
    serverUrl,
    mcpToolName: 'web_search_exa',
    category: 'web',
    access: 'read-only',
    loadTier: 'T0',
    permission: 'auto',
    paths: ['*'],
    input: z.object({ query: z.string() }),
    output: z.object({ answer: z.string() }),
  });
  const handler = createStudioDraftHandler();
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    return url.startsWith(`${SERVER}/`) ? handler(new Request(url, init)) : fail(url);
  }) as typeof fetch;
  try {
    const exec = executeRegisteredTool({
      tools: scope.tools,
      profile,
      name: 'search',
      input: { query: 'kv limits' },
      callId: crypto.randomUUID(),
      ctx: { fetch: forwardedFetch(SERVER) },
    });
    for (;;) {
      const next = await exec.next();
      if (next.done) return next.value;
    }
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test('a call the browser refuses says which request failed, and that CORS or the network may be why', async () => {
  // A browser's fetch rejects a CORS refusal and an unreachable host alike, with no reason.
  const settled = await failedCall('http://127.0.0.1:9/mcp', () =>
    Promise.reject(new TypeError('Failed to fetch')),
  );
  assertEquals(settled.failure?.code, 'network_error');
  const message = settled.failure?.message ?? '';
  assertStringIncludes(message, 'POST http://127.0.0.1:9/mcp');
  assertStringIncludes(message, 'CORS');
});

Deno.test("a call the studio's server cannot send says which request failed", async () => {
  const settled = await failedCall('https://mcp.example.com/mcp', () =>
    Promise.reject(new TypeError('error sending request: connection refused')),
  );
  assertEquals(settled.failure?.code, 'network_error');
  const message = settled.failure?.message ?? '';
  assertStringIncludes(message, 'POST https://mcp.example.com/mcp');
  assertStringIncludes(message, 'connection refused');
});

Deno.test('an MCP server that answers with an error status is named in the failure', async () => {
  const settled = await failedCall('https://mcp.example.com/mcp', () =>
    Promise.resolve(new Response('busy', { status: 503 })),
  );
  assertStringIncludes(settled.failure?.message ?? '', 'HTTP 503 from mcp.example.com');
});
