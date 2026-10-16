import { z } from 'zod';
import { memoryCredentialSource } from '../../src/kernel/auth/credential-source.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { executeRegisteredTool } from '../../src/kernel/tools/mod.ts';
import { MAX_TOOL_RESPONSE_BYTES } from '../../src/kernel/tools/remote.ts';
import type { ToolStageSupport } from '../../src/kernel/tools/stage-run.ts';
import type { ToolDefinitionInput } from '../../src/kernel/tools/types.ts';
import type { Profile, TurnEvent } from '../../src/kernel/types.ts';
import { createTestKernelScope } from '../fixtures/provider-scope.ts';

const KEY = 'http-draft-key-sentinel';
const RESOLVE = () => Promise.resolve(['93.184.216.34']);

const profile: Profile = {
  id: 'http-draft',
  type: 'text',
  identity: { handle: 'http-draft' },
  models: { m: { provider: 'openrouter', apiId: 'test' } },
  defaultModel: 'm',
  tools: { allow: ['report'] },
  inputs: { text: true },
  outputs: {},
};

const TOOL = {
  name: 'report',
  description: 'A report',
  category: 'api',
  access: 'read-only',
  loadTier: 'T0',
  permission: 'auto',
  paths: ['*'],
  input: z.object({}),
  output: z.object({ finding: z.string() }),
  type: 'http',
  endpoint: 'https://api.report.example/v1/report',
  method: 'GET',
  mapping: {},
  auth: { slot: 'report', service: 'Report', type: 'api_key', queryParam: 'key' },
} as ToolDefinitionInput;

/** A response whose body arrives in `pieces`. */
function streamed(pieces: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

async function run(respond: () => Response, drafts: boolean) {
  const scope = createTestKernelScope();
  scope.tools.register(TOOL);
  const stages: ToolStageSupport = {
    handlers: [],
    profile,
    step: 1,
    history: () => [],
    injectAllowed: false,
    drafts,
  };
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(respond());
  try {
    const events: TurnEvent[] = [];
    const exec = executeRegisteredTool({
      tools: scope.tools,
      profile,
      name: 'report',
      input: {},
      callId: 'call-1',
      stages,
      ctx: {
        credentials: memoryCredentialSource({ report: { type: 'api_key', key: KEY } }),
        resolveHost: RESOLVE,
      },
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

function draftText(events: TurnEvent[]): string {
  return events
    .flatMap((e) =>
      e.type === 'tool' && 'phase' in e.tool && e.tool.phase === 'draft' ? [e.tool.text] : [],
    )
    .join('');
}

const BODY = ['{"finding":', '"Soil is ', 'dry."}'];

Deno.test("under sse an http tool's body reaches the host as drafts, and its output arrives", async () => {
  const { events, settlement } = await run(() => streamed(BODY), true);
  assertEquals(draftText(events), BODY.join(''));
  assertEquals(settlement.outputRaw, { finding: 'Soil is dry.' });
});

Deno.test('a credential split across pieces of the body never shows in its drafts', async () => {
  const half = Math.floor(KEY.length / 2);
  const { events, settlement } = await run(
    () => streamed(['{"finding":"key ', KEY.slice(0, half), KEY.slice(half), ' end"}']),
    true,
  );
  assertEquals(draftText(events), '{"finding":"key [omitted - credential] end"}');
  assertEquals(JSON.stringify({ events, settlement }).includes(KEY.slice(0, half)), false);
});

Deno.test('buffered sends no drafts: the output is the whole', async () => {
  const { events, settlement } = await run(() => streamed(BODY), false);
  assertEquals(draftText(events), '');
  assertEquals(settlement.outputRaw, { finding: 'Soil is dry.' });
});

Deno.test('a failed response reads whole, with no drafts', async () => {
  const { events, settlement } = await run(
    () => streamed(['{"error":', '"down"}'], { status: 503 }),
    true,
  );
  assertEquals(draftText(events), '');
  assertEquals(settlement.failure?.code, 'http_503');
});

Deno.test('a body past the cap fails as too large', async () => {
  const piece = 'x'.repeat(1024 * 1024);
  const { settlement } = await run(
    () => streamed(['{"finding":"', piece, piece, piece, piece, piece, '"}']),
    true,
  );
  assertEquals(settlement.failure?.code, 'response_too_large');
  assertEquals(MAX_TOOL_RESPONSE_BYTES < 5 * piece.length, true);
});
