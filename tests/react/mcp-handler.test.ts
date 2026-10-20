import { assert, assertEquals, assertThrows } from '@std/assert';
import { z } from 'zod';
import { invokeTool, type ProfileDefinition, registerTool } from '../../mod.ts';
import { createTheoremMcpHandler } from '../../react/src/server/mod.ts';
import { toolEventsOf } from '../fixtures/events.ts';

const ENDPOINT = 'http://mcp.test/mcp';
const MODERN = '2026-07-28';
type Handler = (request: Request) => Promise<Response>;
const ran: string[] = [];
registerTool({
  type: 'function',
  name: 'mcp_handler_lookup',
  description: 'Look a record up',
  category: 'test',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
  input: z.object({ id: z.string() }),
  output: z.object({ id: z.string(), size: z.number() }),
  handler: (input) => {
    const { id } = input as { id: string };
    ran.push(`lookup:${id}`);
    return { id, size: id.length };
  },
});
registerTool({
  type: 'function',
  name: 'mcp_handler_fail',
  description: 'Always fails',
  category: 'test',
  access: 'destructive',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
  input: z.object({}),
  output: z.object({}),
  handler: () => {
    throw new Error('the record store is down');
  },
});
registerTool({
  type: 'function',
  name: 'mcp_handler_confirm',
  description: 'Needs approval',
  category: 'test',
  access: 'destructive',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'always_confirm',
  input: z.object({}),
  output: z.object({}),
  handler: () => ({}),
});
type HostDefinition = Extract<ProfileDefinition, { type: 'host' }>;
function host(id: string, allow: string[]): HostDefinition {
  return { type: 'host', id, tools: { allow }, guardrails: { detect: { injection: 'ignore' } } };
}
function handlerFor(id: string, allow = ['mcp_handler_lookup', 'mcp_handler_fail']): Handler {
  return createTheoremMcpHandler({
    profile: host(id, allow),
    version: '1.2.3',
    instructions: 'Look records up.',
  });
}
let nextId = 1;
/** A request as a client on the current revision sends it: version and capabilities on it. */
function modern(method: string, params: Record<string, unknown> = {}, headers: HeadersInit = {}) {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MODERN,
      'mcp-method': method,
      ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: nextId++,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}
/** A message as a client on an earlier revision sends it. */
function legacy(body: Record<string, unknown>, headers: HeadersInit = {}) {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', ...body }),
  });
}

Deno.test('discovery names the versions, the tools capability, and the server', async () => {
  const res = await handlerFor('mcp-discover')(modern('server/discover'));
  assertEquals(res.status, 200);
  const { result } = await res.json();
  assertEquals(result.resultType, 'complete');
  assertEquals(result.supportedVersions[0], MODERN);
  assertEquals(result.capabilities, { tools: {} });
  assertEquals(result.instructions, 'Look records up.');
  assertEquals(result._meta['io.modelcontextprotocol/serverInfo'], {
    name: 'mcp-discover',
    version: '1.2.3',
  });
});

Deno.test('the tool list is the profile allow list, with input schemas and access as hints', async () => {
  const res = await handlerFor('mcp-list')(modern('tools/list'));
  const { result } = await res.json();
  assertEquals(
    result.tools.map(({ name, annotations }: { name: string; annotations: unknown }) => ({
      name,
      annotations,
    })),
    [
      { name: 'mcp_handler_lookup', annotations: { readOnlyHint: true } },
      { name: 'mcp_handler_fail', annotations: { readOnlyHint: false, destructiveHint: true } },
    ],
  );
  assertEquals(result.tools[0].inputSchema.type, 'object');
  assertEquals(result.tools[0].inputSchema.required, ['id']);
});

Deno.test('a call returns the text the model would read back, not the raw output', async () => {
  const res = await handlerFor('mcp-call')(
    modern('tools/call', { name: 'mcp_handler_lookup', arguments: { id: 'abc' } }),
  );
  const { result } = await res.json();
  assertEquals(result.isError, false);
  assertEquals(result.structuredContent, undefined);
  const events = [];
  for await (const event of invokeTool({
    profile: 'mcp-call',
    name: 'mcp_handler_lookup',
    input: { id: 'abc' },
  }))
    events.push(event);
  const [complete] = toolEventsOf(events, 'complete');
  assert(complete?.readBack);
  assertEquals(result.content, [{ type: 'text', text: complete.readBack }]);
});

Deno.test('a failing tool is a result marked as an error, for the model to read', async () => {
  const res = await handlerFor('mcp-fail')(
    modern('tools/call', { name: 'mcp_handler_fail', arguments: {} }),
  );
  assertEquals(res.status, 200);
  const { result } = await res.json();
  assertEquals(result.isError, true);
  assertEquals(result.content[0].type, 'text');
});

Deno.test('input the schema refuses is a tool error, and the tool never runs', async () => {
  const before = ran.length;
  const res = await handlerFor('mcp-bad-input')(
    modern('tools/call', { name: 'mcp_handler_lookup', arguments: { id: 7 } }),
  );
  const { result } = await res.json();
  assertEquals(result.isError, true);
  assertEquals(ran.length, before);
});

Deno.test('a tool the profile does not allow is an unknown tool', async () => {
  const res = await handlerFor('mcp-unknown', ['mcp_handler_lookup'])(
    modern('tools/call', { name: 'mcp_handler_fail', arguments: {} }),
  );
  const body = await res.json();
  assertEquals(body.error.code, -32602);
});

Deno.test('headers that disagree with the body are refused', async () => {
  const res = await handlerFor('mcp-mismatch')(
    modern(
      'tools/call',
      { name: 'mcp_handler_lookup', arguments: { id: 'a' } },
      { 'mcp-name': 'mcp_handler_fail' },
    ),
  );
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, -32020);
});

Deno.test('a version the server does not speak is refused with the ones it does', async () => {
  const request = modern('tools/list');
  const body = await request.json();
  body.params._meta['io.modelcontextprotocol/protocolVersion'] = '1900-01-01';
  const res = await handlerFor('mcp-version')(
    new Request(ENDPOINT, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(body),
    }),
  );
  assertEquals(res.status, 400);
  const { error } = await res.json();
  assertEquals(error.code, -32022);
  assertEquals(error.data.requested, '1900-01-01');
  assert(error.data.supported.includes(MODERN));
});

Deno.test('an unknown method is 404 on the current revision', async () => {
  const res = await handlerFor('mcp-method')(modern('prompts/list'));
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error.code, -32601);
});

Deno.test('an earlier client opens with initialize and is served without a session', async () => {
  const handler = handlerFor('mcp-legacy');
  const opened = await handler(
    legacy({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
  );
  assertEquals(opened.headers.get('mcp-session-id'), null);
  const { result } = await opened.json();
  assertEquals(result.protocolVersion, '2025-06-18');
  assertEquals(result.serverInfo, { name: 'mcp-legacy', version: '1.2.3' });
  assertEquals(result.resultType, undefined);
  const notified = await handler(legacy({ method: 'notifications/initialized' }));
  assertEquals(notified.status, 202);
  const called = await handler(
    legacy(
      {
        id: 2,
        method: 'tools/call',
        params: { name: 'mcp_handler_lookup', arguments: { id: 'xy' } },
      },
      { 'mcp-protocol-version': '2025-06-18' },
    ),
  );
  assertEquals((await called.json()).result.isError, false);
});

Deno.test('an initialize for an unknown revision gets the newest earlier one', async () => {
  const res = await handlerFor('mcp-legacy-unknown')(
    legacy({ id: 1, method: 'initialize', params: { protocolVersion: '2024-01-01' } }),
  );
  assertEquals((await res.json()).result.protocolVersion, '2025-11-25');
});

Deno.test('only POST is served', async () => {
  const res = await handlerFor('mcp-get')(new Request(ENDPOINT));
  assertEquals(res.status, 405);
  assertEquals(res.headers.get('allow'), 'POST');
});

Deno.test('a page on another origin is refused unless the host lists it', async () => {
  const from = { origin: 'https://elsewhere.example' };
  assertEquals((await handlerFor('mcp-origin')(modern('tools/list', {}, from))).status, 403);
  const listed = createTheoremMcpHandler({
    profile: host('mcp-origin-listed', ['mcp_handler_lookup']),
    version: '1',
    origins: ['https://elsewhere.example'],
  });
  assertEquals((await listed(modern('tools/list', {}, from))).status, 200);
});

Deno.test('a body that is not one JSON-RPC request is refused', async () => {
  const handler = handlerFor('mcp-malformed');
  const batch = await handler(
    new Request(ENDPOINT, { method: 'POST', body: JSON.stringify([{ jsonrpc: '2.0' }]) }),
  );
  assertEquals((await batch.json()).error.code, -32600);
  const garbled = await handler(new Request(ENDPOINT, { method: 'POST', body: '{' }));
  assertEquals((await garbled.json()).error.code, -32700);
});

Deno.test('a profile with a tool that needs approval is refused at setup', () => {
  assertThrows(
    () =>
      createTheoremMcpHandler({
        profile: host('mcp-gated', ['mcp_handler_confirm']),
        version: '1',
      }),
    Error,
    "'mcp_handler_confirm' has permission 'always_confirm'",
  );
});
