import { assert, assertEquals, assertThrows } from '@std/assert';
import { z } from 'zod';
import { type ProfileDefinition, registerTool, type TurnEvent } from '../../mod.ts';
import { createHostTransport } from '../../react/src/client/host-transport.ts';
import type { TurnEventSink } from '../../react/src/client/transport.ts';
import { createTheoremHandler, createTheoremHostHandler } from '../../react/src/server/mod.ts';
import { toolEventsOf } from '../fixtures/events.ts';

const BASE = 'http://host.test/api/host';
type Handler = (request: Request) => Promise<Response>;

const ran: string[] = [];

registerTool({
  type: 'function',
  name: 'host_handler_lookup',
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
  name: 'host_handler_delete',
  description: 'Delete a record',
  category: 'test',
  access: 'destructive',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'always_confirm',
  input: z.object({ id: z.string() }),
  output: z.object({ deleted: z.string() }),
  handler: (input) => {
    const { id } = input as { id: string };
    ran.push(`delete:${id}`);
    return { deleted: id };
  },
});
registerTool({
  type: 'http',
  name: 'host_handler_http',
  description: 'Looks items up',
  endpoint: 'https://internal.example/items',
  method: 'GET',
  headers: { 'x-api-key': 'static-key-value' },
  category: 'api',
  access: 'read-only',
  loadTier: 'T0',
  permission: 'auto',
  paths: ['*'],
  input: z.object({ q: z.string() }),
  output: z.object({}).passthrough(),
});

type HostDefinition = Extract<ProfileDefinition, { type: 'host' }>;

function host(id: string, allow: string[]): HostDefinition {
  return { type: 'host', id, tools: { allow }, guardrails: { detect: { injection: 'ignore' } } };
}

/** A browser: keeps the session cookie the handler issues. */
function transportFor(handler: Handler) {
  let cookie = '';
  return createHostTransport({
    endpoint: BASE,
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      if (cookie) headers.set('cookie', cookie);
      const response = await handler(new Request(url, { ...init, headers }));
      const issued = response.headers.get('set-cookie');
      if (issued) cookie = issued.split(';')[0];
      return response;
    },
  });
}

async function collect(run: (onEvent: TurnEventSink) => Promise<void>): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  await run((event) => {
    if (event.type === 'unsupported') throw new Error(`unsupported line: ${event.received}`);
    if (event.type === 'malformed') throw event.error;
    events.push(event);
  });
  return events;
}

function post(handler: Handler, path: string, body: unknown) {
  return handler(
    new Request(`${BASE}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

Deno.test("describe lists the host's allowed tools with their schemas, and nothing of their endpoints", async () => {
  const handler = createTheoremHostHandler({
    profile: host('host-handler-describe', ['host_handler_lookup', 'host_handler_http']),
  });
  const iface = await transportFor(handler).describe();
  assertEquals(iface.type, 'host');
  assertEquals(
    iface.tools.map(({ name, kind, access, permission }) => ({ name, kind, access, permission })),
    [
      { name: 'host_handler_lookup', kind: 'function', access: 'read-only', permission: 'auto' },
      { name: 'host_handler_http', kind: 'http', access: 'read-only', permission: 'auto' },
    ],
  );
  const lookup = iface.tools[0];
  assertEquals(lookup?.inputSchema.required, ['id']);
  assert(lookup?.outputSchema.properties !== undefined);
  const wire = JSON.stringify(iface);
  assertEquals(wire.includes('internal.example'), false);
  assertEquals(wire.includes('static-key-value'), false);
});

Deno.test('a call streams the tool through to its output', async () => {
  const handler = createTheoremHostHandler({
    profile: host('host-handler-call', ['host_handler_lookup']),
  });
  const events = await collect((onEvent) =>
    transportFor(handler).call({ name: 'host_handler_lookup', input: { id: 'abc' } }, onEvent),
  );
  const [complete] = toolEventsOf(events, 'complete');
  assertEquals(complete?.output, { id: 'abc', size: 3 });
  assertEquals(events.at(-1)?.type, 'done');
});

Deno.test('a call body without a tool name is refused before anything runs', async () => {
  const handler = createTheoremHostHandler({
    profile: host('host-handler-bad-body', ['host_handler_lookup']),
  });
  const res = await post(handler, 'call', { input: { id: 'abc' } });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).errorKind, 'request');
});

Deno.test('a tool the host does not allow never runs', async () => {
  const before = ran.length;
  const handler = createTheoremHostHandler({
    profile: host('host-handler-not-allowed', ['host_handler_lookup']),
  });
  const events = await collect((onEvent) =>
    transportFor(handler).call({ name: 'host_handler_delete', input: { id: 'r1' } }, onEvent),
  );
  assertEquals(ran.length, before);
  assertEquals(toolEventsOf(events, 'complete').length, 0);
});

Deno.test('a gated call pauses, and runs only once the user approves it', async () => {
  const handler = createTheoremHostHandler({
    profile: host('host-handler-gate', ['host_handler_delete']),
  });
  const transport = transportFor(handler);
  const paused = await collect((onEvent) =>
    transport.call({ name: 'host_handler_delete', input: { id: 'r7' } }, onEvent),
  );
  const gate = toolEventsOf(paused, 'gate').at(-1);
  assert(gate, 'expected the call to pause on a gate');
  assertEquals(ran.includes('delete:r7'), false);

  const settled = await collect((onEvent) =>
    transport.invoke({ gateId: gate.callId, decision: 'approve' }, onEvent),
  );
  // The answer's stream resumes the call the first one paused.
  assertEquals(toolEventsOf(settled, 'complete')[0]?.output, { deleted: 'r7' });
  assert(ran.includes('delete:r7'));
});

Deno.test('a host serves no chat: its turn route is refused', async () => {
  const handler = createTheoremHostHandler({
    profile: host('host-handler-no-turn', ['host_handler_lookup']),
  });
  const res = await post(handler, 'turn', { input: { text: 'hi' } });
  assertEquals(res.status >= 400 && res.status < 500, true);
});

Deno.test('each handler refuses the other kind of profile, naming the right one', () => {
  assertThrows(
    () =>
      createTheoremHandler({
        profile: host('host-handler-wrong-a', []) as never,
        provider: () => ({ complete: () => (async function* () {})() }),
      }),
    Error,
    'createTheoremHostHandler',
  );
  assertThrows(
    () =>
      createTheoremHostHandler({
        profile: {
          type: 'text',
          id: 'host-handler-wrong-b',
          identity: { handle: 'helper', system: 'x' },
          key: 'slot_a',
          models: { stub: { protocol: 'openAi', provider: 'openrouter', apiId: 'stub-model' } },
          tools: { allow: [] },
          inputs: { text: true },
        } as never,
      }),
    Error,
    "serves type 'host'",
  );
});
