import { assert, assertEquals } from '@std/assert';
import { z } from 'zod';
import {
  defineProfile,
  registerProfile,
  registerTool,
  type ToolAccess,
  type ToolPermission,
  type TurnEvent,
} from '../../mod.ts';
import { createHostTransport } from '../../react/src/client/host-transport.ts';
import type { TurnEventSink } from '../../react/src/client/transport.ts';
import { writeAsk, writeAskLine } from '../../studio/asks.ts';
import { defaultToolSpec } from '../../studio/draft.ts';
import { createStudioHandler, type StudioDescription } from '../../studio/server/handler.ts';
import { toolEventsOf } from '../fixtures/events.ts';

const HOST = '127.0.0.1:4983';
const BASE = `http://${HOST}/api/studio`;
const ran: string[] = [];

function tool(name: string, access: ToolAccess, permission: ToolPermission) {
  registerTool({
    type: 'function',
    name,
    description: 'A tool the studio runs.',
    category: 'test',
    access,
    paths: ['*'],
    loadTier: 'T0',
    permission,
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string() }),
    handler: (input) => {
      const { id } = input as { id: string };
      ran.push(`${name}:${id}`);
      return { id };
    },
  });
}
tool('asks_read', 'read-only', 'auto');
tool('asks_write', 'read-write', 'auto');
tool('asks_remove', 'destructive', 'session_consent');
tool('asks_already', 'read-write', 'always_confirm');
registerProfile(
  defineProfile({
    type: 'host',
    id: 'asks-desk',
    tools: { allow: ['asks_read', 'asks_write', 'asks_remove', 'asks_already'] },
  }),
);

const handler = createStudioHandler({ project: 'asks', pageOrigins: [], listenHost: HOST });

/** The studio's page: keeps the session cookie the handler issues. */
function transport() {
  let cookie = '';
  return createHostTransport({
    endpoint: `${BASE}/profiles/asks-desk`,
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('host', HOST);
      if (cookie) headers.set('cookie', cookie);
      const response = await handler(new Request(url, { ...init, headers }));
      const issued = response.headers.get('set-cookie');
      if (issued) cookie = issued.split(';')[0] ?? '';
      return response;
    },
  });
}

async function collect(run: (onEvent: TurnEventSink) => Promise<void>): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  await run((event) => {
    if (event.type === 'unsupported' || event.type === 'malformed')
      throw new Error('A line the page cannot read.');
    events.push(event);
  });
  return events;
}

Deno.test('the page reads each tool as the files set it, and which ones the studio makes ask', async () => {
  const response = await handler(new Request(BASE, { headers: { host: HOST } }));
  const { workspace, asks }: StudioDescription = await response.json();
  const set = (name: string) =>
    workspace.toolSpecs.find((spec) => spec.toolName === name)?.permission;
  assertEquals(
    [set('asks_write'), set('asks_remove'), set('asks_already')],
    ['auto', 'session_consent', 'always_confirm'],
  );
  assertEquals(
    asks.filter((name) => name.startsWith('asks_')),
    ['asks_write', 'asks_remove'],
  );
});

Deno.test('a tool that reads runs unasked', async () => {
  const events = await collect((onEvent) =>
    transport().call({ name: 'asks_read', input: { id: 'a' } }, onEvent),
  );
  assertEquals(toolEventsOf(events, 'complete')[0]?.output, { id: 'a' });
});

Deno.test('a tool that writes stops before every run, and runs only once the builder says so', async () => {
  for (const name of ['asks_write', 'asks_remove']) {
    const page = transport();
    for (const id of ['first', 'second']) {
      const paused = await collect((onEvent) => page.call({ name, input: { id } }, onEvent));
      const gate = toolEventsOf(paused, 'gate').at(-1);
      assert(gate, `${name} ran unasked`);
      assertEquals(ran.includes(`${name}:${id}`), false);
      const settled = await collect((onEvent) =>
        page.invoke({ gateId: gate.callId, decision: 'approve' }, onEvent),
      );
      assertEquals(toolEventsOf(settled, 'complete')[0]?.output, { id });
    }
  }
});

Deno.test('a run the builder refuses never happens', async () => {
  const page = transport();
  const paused = await collect((onEvent) =>
    page.call({ name: 'asks_write', input: { id: 'no' } }, onEvent),
  );
  const gate = toolEventsOf(paused, 'gate').at(-1);
  assert(gate);
  const settled = await collect((onEvent) =>
    page.invoke({ gateId: gate.callId, decision: 'deny' }, onEvent),
  );
  assertEquals(
    [toolEventsOf(settled, 'complete').length, ran.includes('asks_write:no')],
    [0, false],
  );
});

Deno.test("the editor's Test asks before a real request from a tool that writes, and only then", () => {
  const http = {
    toolType: 'http' as const,
    method: 'DELETE' as const,
    endpoint: 'https://garden.test/plants/{id}',
  };
  const removal = defaultToolSpec({ ...http, toolName: 'remove_plant', access: 'destructive' });
  const ask = writeAsk(removal, ' {"id":"fern"} ');
  assertEquals(ask, {
    tool: 'remove_plant',
    access: 'destructive',
    sends: 'DELETE https://garden.test/plants/{id}',
    input: '{"id":"fern"}',
  });
  assert(ask);
  assertEquals(
    writeAskLine(ask),
    'It is set as destructive. Run sends a real request: DELETE https://garden.test/plants/{id}',
  );
  const logging = writeAsk(
    defaultToolSpec({ ...http, method: undefined, access: 'read-write' }),
    '',
  );
  assertEquals([logging?.sends, logging?.input], ['GET https://garden.test/plants/{id}', '{}']);
  assert(logging);
  assertEquals(writeAskLine(logging).startsWith('It is set as read and write.'), true);

  assertEquals(writeAsk(defaultToolSpec({ ...http, access: 'read-only' }), '{}'), undefined);
  // A function tool has no request the page can make, and an MCP test only lists the server's tools.
  assertEquals(
    writeAsk(defaultToolSpec({ toolType: 'function', access: 'destructive' }), '{}'),
    undefined,
  );
  assertEquals(
    writeAsk(defaultToolSpec({ toolType: 'mcp', access: 'destructive' }), '{}'),
    undefined,
  );
});
