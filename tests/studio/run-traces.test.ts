import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';

registerFixtureProviders(defaultKernelScope);

import { assertEquals } from '@std/assert';
import { z } from 'zod';
import {
  getTraceDestination,
  registerProfile,
  registerTool,
  registerTraceDestination,
  type TraceRecord,
} from '../../mod.ts';
import { createStudioHandler } from '../../studio/server/handler.ts';
import { STUDIO_RUN_TRACES, withRunTraces } from '../../studio/server/run-traces.ts';

const HOST = '127.0.0.1:4983';
const BASE = `http://${HOST}/api/studio`;

/** What the profiles' own trace store was written. */
const stored: unknown[] = [];
registerTraceDestination('bench-store', {
  write: (record) => {
    stored.push(record);
    return Promise.resolve();
  },
});
registerTool({
  type: 'function',
  name: 'echo_note',
  description: 'Gives the note back.',
  category: 'test',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
  input: z.object({ note: z.string() }),
  output: z.object({ note: z.string() }),
  handler: async ({ note }) => {
    // Two calls at once overlap, so each must still get its own records.
    await new Promise((resolve) => setTimeout(resolve, note === 'slow' ? 30 : 5));
    return { note };
  },
});
registerProfile({
  type: 'host',
  id: 'bench-tools',
  observability: { writeTo: 'bench-store' },
  tools: { allow: ['echo_note'] },
});
registerProfile({ type: 'host', id: 'quiet-tools', tools: { allow: ['echo_note'] } });
registerProfile({
  type: 'text',
  id: 'bench-chat',
  observability: { writeTo: 'bench-store' },
  identity: { handle: 'Bench', system: 'You reply.' },
  inputs: { text: true },
  models: { main: { provider: 'openrouter', apiId: 'test/model' } },
  tools: { allow: [] },
});

const handler = createStudioHandler({
  project: 'bench',
  pageOrigins: [],
  listenHost: HOST,
  provider: {
    vault: { slot_a: 'k' },
    fetch: () => Promise.resolve(new Response('no', { status: 500 })),
  },
});

type Line = { type: string; record?: { content?: unknown } };

/** Posts to a profile and gives the lines it streamed. */
async function lines(path: string, body: unknown): Promise<Line[]> {
  const response = await handler(
    new Request(`${BASE}/profiles/${path}`, {
      method: 'POST',
      headers: { host: HOST, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const call = (profile: string, note: string) =>
  lines(`${profile}/call`, { name: 'echo_note', input: { note } });

Deno.test("a tool call's trace reaches the page and stays out of the profile's store", async () => {
  const sent = await call('bench-tools', 'one');
  assertEquals(sent.filter((line) => line.type === 'trace').length, 1);
  assertEquals(sent.at(-1)?.type, 'trace');
  assertEquals(stored, []);
});

Deno.test('a profile that records nothing sends no trace', async () => {
  const sent = await call('quiet-tools', 'one');
  assertEquals(sent.filter((line) => line.type === 'trace').length, 0);
  assertEquals(sent.length > 0, true);
});

Deno.test('two runs at once each get their own trace', async () => {
  const [slow, fast] = await Promise.all([
    call('bench-tools', 'slow'),
    call('bench-tools', 'fast'),
  ]);
  for (const [sent, note] of [
    [slow, 'slow'],
    [fast, 'fast'],
  ] as const) {
    const traces = sent.filter((line) => line.type === 'trace');
    assertEquals(traces.length, 1);
    assertEquals(JSON.stringify(traces[0]?.record?.content).includes(note), true);
  }
});

Deno.test("a chat turn's trace reaches the page behind its events", async () => {
  const sent = await lines('bench-chat/turn', {
    input: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }] },
  });
  const types = sent.map((line) => line.type);
  assertEquals(types.filter((type) => type === 'trace').length, 1);
  assertEquals(types.at(-1), 'trace');
  assertEquals(stored, []);
});

Deno.test('a stream that ends in a failure sends its trace ahead of it, so the page reads it', async () => {
  const record = (await call('bench-tools', 'one')).find((line) => line.type === 'trace')?.record;
  const serve = withRunTraces(async () => {
    await getTraceDestination(STUDIO_RUN_TRACES)?.write(record as TraceRecord, {
      retainForDays: 0,
      rotateAfterMiB: 1,
    });
    return new Response('{"type":"stage"}\n{"type":"error","error":"no"}', {
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
    });
  });
  const text = await (await serve(new Request(BASE))).text();
  const types = text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).type);
  assertEquals(types, ['stage', 'trace', 'error']);
});
