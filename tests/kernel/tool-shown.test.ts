/**
 * What a tool's call shows the person is read at `tool_shown_<kind>`, apart from what the model
 * reads back: the host's server forwards the turn's events to the browser as they are.
 */

import '../fixtures/test-host.ts';
import { z } from 'zod';
import { TEST_OPENAI_KEY } from '../../src/guardrails/corpus/secrets.ts';
import type { DetectSpec } from '../../src/guardrails/detectors.ts';
import { labelText } from '../../src/guardrails/labels.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { executeFunction } from '../../src/kernel/tools/execute.ts';
import type { FunctionToolDef, ToolContext } from '../../src/kernel/tools/types.ts';
import type { Profile, TurnEvent } from '../../src/kernel/types.ts';
import { readAt } from '../fixtures/detect.ts';
import { eventsOf, toolEventsOf } from '../fixtures/events.ts';
import { TAKE_OUT_INBOUND } from '../fixtures/take-out.ts';

const KEY = TEST_OPENAI_KEY;
const PLACEHOLDER = readAt(KEY, 'tool_shown_function', { credentials: 'redact' }).text ?? '';
const base = { name: 'lookup', callId: 'c1' };
const Output = z.object({ body: z.string() });

function tool(handler: FunctionToolDef['handler'], labels?: Record<string, string>) {
  return {
    type: 'function',
    name: 'lookup',
    description: 'lookup',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: Output,
    inputSchema: {},
    outputSchema: {},
    handler,
    ...(labels ? { labels } : {}),
  } as unknown as FunctionToolDef;
}

async function run(def: FunctionToolDef, detect: DetectSpec = TAKE_OUT_INBOUND) {
  const profile = {
    id: 'tool-shown',
    type: 'text',
    tools: { allow: ['lookup'] },
    guardrails: { detect },
  } as unknown as Profile;
  const ctx = { profile, callId: base.callId } as ToolContext;
  const gen = executeFunction(defaultKernelScope.tools, def, {}, ctx, base);
  const events: TurnEvent[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { events, settlement: next.value };
    events.push(next.value);
  }
}

function shownReports(events: readonly TurnEvent[]): string[] {
  return eventsOf(events, 'guardrail')
    .filter(({ guardrail }) => guardrail.boundary === 'tool_shown_function')
    .map(({ guardrail }) => guardrail.action);
}

Deno.test('a key a tool returns is flagged in what the person is shown, by default', async () => {
  const { events } = await run(
    tool(() => ({ body: `found ${KEY}` })),
    {},
  );
  const [complete] = toolEventsOf(events, 'complete');
  assertEquals(complete?.output, { body: `found ${KEY}` });
  assertEquals(shownReports(events), ['flag']);
});

Deno.test('a key a tool returns is redacted from what the person is shown, when the profile takes it out', async () => {
  const { events, settlement } = await run(
    tool(() => ({ body: `found ${KEY}` }), { activityPast: 'Read {output.body}' }),
  );
  const [complete] = toolEventsOf(events, 'complete');
  assertEquals(complete?.output, { body: `found ${PLACEHOLDER}` });
  assertEquals(complete?.activityPast, `Read found ${PLACEHOLDER}`);
  assertEquals(shownReports(events), ['redact']);
  // why: The host's own code is handed what its handler returned, unread.
  assertEquals(settlement.outputRaw, { body: `found ${KEY}` });
});

Deno.test('what the model reads back is not changed by what the person is shown', async () => {
  const { events } = await run(
    tool(() => ({ body: `found ${KEY}` })),
    {
      credentials: { at: { ...TAKE_OUT_INBOUND.credentials.at, tool_output_function: 'ignore' } },
    },
  );
  const [complete] = toolEventsOf(events, 'complete');
  assertEquals(complete?.readBack?.includes(KEY), true);
  assertEquals(JSON.stringify(complete?.output).includes(KEY), false);
});

Deno.test('a block at tool_shown shows the labels’ words in place of the output', async () => {
  const { events } = await run(
    tool(() => ({ body: `found ${KEY}` })),
    {
      credentials: { at: { tool_shown_function: 'block' } },
    },
  );
  const [complete] = toolEventsOf(events, 'complete');
  assertEquals(complete?.output, labelText('detect.shown_blocked', {}));
  assertEquals(shownReports(events), ['block']);
});

Deno.test('ignore at tool_shown shows the output as returned', async () => {
  const { events } = await run(
    tool(() => ({ body: `found ${KEY}` })),
    {
      credentials: { at: { tool_shown_function: 'ignore' } },
    },
  );
  const [complete] = toolEventsOf(events, 'complete');
  assertEquals(complete?.output, { body: `found ${KEY}` });
  assertEquals(shownReports(events), []);
});

Deno.test('a failed call’s error text is read at tool_shown', async () => {
  const { events } = await run(
    tool(() => {
      throw new Error(`upstream said ${KEY}`);
    }),
  );
  const [error] = toolEventsOf(events, 'error');
  assertEquals(error?.failure.message.includes(KEY), false);
  assertEquals(shownReports(events), ['redact']);
});

Deno.test('an artifact and a trace step are read at tool_shown; a blocked one is not sent', async () => {
  const streamed = tool(async function* () {
    await Promise.resolve();
    yield { kind: 'artifact', artifact: { note: `saved ${KEY}` } };
    yield {
      kind: 'trace',
      step: { name: 'fetch', kind: 'http', status: 'ok', outputs: { body: KEY } },
    };
    yield { kind: 'complete', output: { body: 'done' } };
  } as unknown as FunctionToolDef['handler']);
  const redacted = await run(streamed);
  assertEquals(toolEventsOf(redacted.events, 'artifact')[0]?.artifact, {
    note: `saved ${PLACEHOLDER}`,
  });
  assertEquals(toolEventsOf(redacted.events, 'trace')[0]?.step.outputs, { body: PLACEHOLDER });

  const blocked = await run(streamed, { credentials: { at: { tool_shown_function: 'block' } } });
  assertEquals(toolEventsOf(blocked.events, 'artifact'), []);
  assertEquals(toolEventsOf(blocked.events, 'trace'), []);
  assertEquals(shownReports(blocked.events), ['block', 'block']);
});
