import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { z } from 'zod';
import { TEST_OPENAI_KEY } from '../../src/guardrails/corpus/secrets.ts';
import { registerProfile, registerTool } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { ToolStreamEvent } from '../../src/kernel/tools/types.ts';
import type { ModelEvent, TurnEvent, TurnModel } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

const TOOL = 'write_report';
const OUTPUT = { finding: 'Report written.' };

/** What the tool yields before its output, set by each test. */
let script: Exclude<ToolStreamEvent, { kind: 'complete' }>[] = [];

registerTool({
  type: 'function',
  name: TOOL,
  description: 'Write a report',
  category: 'test',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
  input: z.object({}),
  output: z.object({ finding: z.string() }),
  handler: async function* () {
    await Promise.resolve();
    yield* script;
    yield { kind: 'complete', output: OUTPUT };
  },
});

function registerReportProfile(id: string, mode?: 'sse' | 'buffered'): string {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id,
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 2,
      tools: { allow: [TOOL] },
      inputs: { text: true },
      ...(mode ? { outputs: { streaming: { mode } } } : {}),
      guardrails: {
        quota: { perDay: 100 },
        detect: { credentials: { at: { tool_output_function: 'block' } } },
      },
    }),
  );
  return id;
}

/** First call: calls the tool; second: a short reply. */
function callingProvider(): TurnModel {
  let call = 0;
  return {
    async *complete(): AsyncGenerator<ModelEvent> {
      await Promise.resolve();
      if (call++ > 0) {
        yield { type: 'text', text: 'Done.' };
        yield { type: 'done', stop: { kind: 'completed' } };
        return;
      }
      yield { type: 'tool', tool: { name: TOOL, callId: 'call_1', arguments: {} } };
      yield { type: 'done', stop: { kind: 'tool' } };
    },
  };
}

async function collect(profile: string): Promise<TurnEvent[]> {
  return await Array.fromAsync(
    runTurn({ profile, input: { text: 'Write it' } }, callingProvider()),
  );
}

function phases(events: TurnEvent[], phase: string) {
  return events.flatMap((e) =>
    e.type === 'tool' && 'phase' in e.tool && e.tool.phase === phase ? [e.tool] : [],
  );
}

function draftText(events: TurnEvent[]): string {
  return phases(events, 'draft')
    .map((tool) => (tool as { text: string }).text)
    .join('');
}

function completed(events: TurnEvent[]): unknown {
  return (phases(events, 'complete')[0] as { output?: unknown } | undefined)?.output;
}

Deno.test("under sse a tool's drafts reach the host before its output", async () => {
  script = [
    { kind: 'draft', text: 'Soil is ' },
    { kind: 'draft', text: 'dry.' },
  ];
  const events = await collect(registerReportProfile('tool_output_draft_sse'));
  assertEquals(draftText(events), 'Soil is dry.');
  const types = events.flatMap((e) =>
    e.type === 'tool' && 'phase' in e.tool ? [e.tool.phase] : [],
  );
  assertEquals(types.lastIndexOf('draft') < types.indexOf('complete'), true);
  assertEquals(completed(events), OUTPUT);
});

Deno.test('a secret split across drafts never shows, and the output still arrives', async () => {
  const half = Math.floor(TEST_OPENAI_KEY.length / 2);
  script = [
    { kind: 'draft', text: 'key ' },
    { kind: 'draft', text: TEST_OPENAI_KEY.slice(0, half) },
    { kind: 'draft', text: TEST_OPENAI_KEY.slice(half) },
    { kind: 'draft', text: ' then more' },
  ];
  const events = await collect(registerReportProfile('tool_output_draft_secret'));
  const shown = draftText(events);
  assertEquals(shown.includes(TEST_OPENAI_KEY.slice(0, half)), false);
  assertEquals(shown.includes('then more'), false);
  assertEquals(JSON.stringify(events).includes(TEST_OPENAI_KEY.slice(0, half)), false);
  assertEquals(completed(events), OUTPUT);
});

Deno.test('a progress its check stops is not sent, its guardrail event is, and the call completes', async () => {
  script = [
    { kind: 'progress', data: { step: 'reading' } },
    { kind: 'progress', data: { leaked: TEST_OPENAI_KEY } },
  ];
  const events = await collect(registerReportProfile('tool_output_draft_progress'));
  assertEquals(
    phases(events, 'progress').map((tool) => (tool as { data: unknown }).data),
    [{ step: 'reading' }],
  );
  assertEquals(JSON.stringify(events).includes(TEST_OPENAI_KEY), false);
  const stopped = events.flatMap((e) =>
    e.type === 'guardrail' && e.guardrail.boundary === 'tool_output_function' ? [e.guardrail] : [],
  );
  assertEquals(
    stopped.map((g) => [g.stage, g.action]),
    [['tool_result', 'block']],
  );
  assertEquals(completed(events), OUTPUT);
});

Deno.test('buffered sends no drafts: the output is the whole', async () => {
  script = [{ kind: 'draft', text: 'Soil is dry.' }];
  const events = await collect(registerReportProfile('tool_output_draft_buffered', 'buffered'));
  assertEquals(phases(events, 'draft').length, 0);
  assertEquals(completed(events), OUTPUT);
});
