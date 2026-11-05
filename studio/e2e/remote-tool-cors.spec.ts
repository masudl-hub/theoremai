import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { PAGE_BASE } from '../page.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// invariant: Exa's own preflight answer (mcp.exa.ai, read 2026-11-02): no Mcp-Method, no Mcp-Name.
const EXA_ALLOWED =
  'Accept, Content-Type, Authorization, x-api-key, x-exa-source, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID';

let server: Server;
let mcp: string;
test.beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers': EXA_ALLOWED,
      });
      response.end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const { id } = JSON.parse(body) as { id: unknown };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mcp = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
});
test.afterAll(() => {
  server.close();
});

// why: an MCP server whose CORS refuses the headers MCP sends failed in the page with only
// "Failed to fetch". This runs the kernel's own MCP call in a real browser against such a server.
test('a tool call the browser refuses by CORS says which request failed and that CORS may be why', async ({
  page,
}) => {
  await page.goto(process.env.STUDIO_URL ?? '');
  const result = await page.evaluate(
    async ({ repo, mcp, base }) => {
      const at = (file: string) => `${location.origin}${base}@fs${repo}/${file}`;
      const kernel = await import(/* @vite-ignore */ at('mod.ts'));
      const { forwardedFetch } = await import(/* @vite-ignore */ at('studio/forwarded-fetch.ts'));
      // The server's own CORS: a request without MCP's headers is let through.
      const plain = await fetch(mcp, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      }).then((r) => r.status);
      const scope = kernel.createKernelScope();
      scope.tools.register({
        name: 'read_pages',
        description: 'Read web pages',
        type: 'mcp',
        serverUrl: mcp,
        mcpToolName: 'web_fetch_exa',
        category: 'research',
        access: 'read-only',
        loadTier: 'T0',
        permission: 'auto',
        paths: ['*'],
        input: kernel.z.object({ urls: kernel.z.array(kernel.z.string()) }),
        output: kernel.z.string(),
      });
      scope.profiles.register({
        type: 'host',
        id: 'reader',
        tools: { allow: ['read_pages'] },
        guardrails: { network: { allowPrivateNetworks: true } },
      });
      const events: { type: string; tool?: { failure?: { message?: string } } }[] = [];
      for await (const event of scope.invokeTool({
        profile: 'reader',
        name: 'read_pages',
        input: { urls: ['https://example.com'] },
        fetch: forwardedFetch(`${location.origin}/api/studio`),
      })) {
        events.push(event);
      }
      const failed = events.find((event) => event.type === 'tool' && event.tool?.failure);
      return { plain, message: failed?.tool?.failure?.message ?? '' };
    },
    { repo, mcp, base: PAGE_BASE },
  );
  expect(result.plain).toBe(200);
  expect(result.message).toContain(`POST ${mcp}`);
  expect(result.message).toContain('CORS');
});
