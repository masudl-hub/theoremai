/**
 * Records → Trial: the root is found by parent, not by position; content
 * resolves across records; delivered text and usage read from the root.
 */

import { buildTrial, groupByTrace } from '../../src/evals/trial.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { buildRecord, type TraceRecord } from '../../src/observability/trace-record.ts';
import { startTrace, traceContent } from '../../src/observability/trace-span.ts';
import { CASE, manualClock, POLICY, turnRecord } from './fixture.ts';

/** A compaction turn's record: a nested `invoke_agent` under the parent turn's root. */
function compactionRecord(parent: TraceRecord): Promise<TraceRecord> {
  const root = parent.spans[0];
  if (!root) throw new Error('fixture has no root');
  const tree = startTrace('invoke_agent compaction', {
    clock: manualClock(),
    traceparent: `00-${root.traceId}-${root.spanId}-01`,
    attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'compaction' },
  });
  tree.root.set({
    'gen_ai.output.messages': [
      { role: 'assistant', parts: [{ type: 'text', ...traceContent('summary') }] },
    ],
  });
  tree.root.end();
  return buildRecord({ spans: tree.collect(), policy: POLICY });
}

Deno.test('the root is the invoke_agent no span parents, even when its record comes last', async () => {
  const turn = await turnRecord({ text: 'La tetera está encendida.' });
  const compaction = await compactionRecord(turn);
  const trial = buildTrial({ suite: 's', case: CASE, index: 0, records: [compaction, turn] });
  assertEquals(trial.root.spanId, turn.spans[0]?.spanId);
  assertEquals(trial.root.attributes['gen_ai.agent.name'], 'translator');
  assertEquals(trial.spans('invoke_agent').length, 2);
});

Deno.test('a turn the host nested under its own span is still the root; the host span is the top', async () => {
  const clock = manualClock();
  const host = startTrace('host.request', { clock });
  clock.tickMs(40);
  const turn = await turnRecord({ traceparent: host.root.traceparent(), clock, durationMs: 100 });
  clock.tickMs(25);
  host.root.end();
  const hostRecord = await buildRecord({ spans: host.collect(), policy: POLICY });
  const trial = buildTrial({ suite: 's', case: CASE, index: 0, records: [hostRecord, turn] });
  assertEquals(trial.root.spanId, turn.spans[0]?.spanId);
  assertEquals(trial.top.spanId, host.root.spanId);
  // Without the host record the turn is its own top, as for a host that writes no span.
  const alone = buildTrial({ suite: 's', case: CASE, index: 0, records: [turn] });
  assertEquals(alone.top.spanId, alone.root.spanId);
});

Deno.test('delivered text and structured output resolve through the merged content', async () => {
  const turn = await turnRecord({ text: 'hola', structured: { lang: 'es' } });
  const trial = buildTrial({ suite: 's', case: CASE, index: 0, records: [turn] });
  const [message] = trial.delivered();
  const parts = message?.parts;
  if (!Array.isArray(parts)) throw new Error('no parts');
  assertEquals(trial.text(parts[0]), 'hola');
  // The turn trace keeps structured JSON under the part's `content`.
  const structured = parts[1];
  if (!structured || typeof structured !== 'object' || Array.isArray(structured))
    throw new Error('no part');
  assertEquals(trial.text(structured.content), JSON.stringify({ lang: 'es' }));
  assertEquals(trial.content(parts[0]), { type: 'text', content: 'hola' });
  assertEquals(trial.content(structured), { type: 'structured', content: { lang: 'es' } });
  assertEquals(trial.text('not a reference'), undefined);
});

Deno.test('usage reads the root: tokens, reasoning share and cost', async () => {
  const turn = await turnRecord({ costUsd: 0.0031 });
  const trial = buildTrial({ suite: 's', index: 0, records: [turn] });
  assertEquals(trial.usage(), {
    tokens: { input: 40, output: 12, total: 52, thinking: 4, cost: { usd: 0.0031 } },
    costUsd: 0.0031,
  });
  assertEquals(trial.case, undefined);
  const free = buildTrial({ suite: 's', index: 0, records: [await turnRecord()] });
  assertEquals(free.usage().costUsd, undefined);
});

Deno.test('spans by operation come in start order across records', async () => {
  const turn = await turnRecord({ tools: ['lookup', 'book'] });
  const trial = buildTrial({ suite: 's', index: 0, records: [turn] });
  assertEquals(
    trial.spans('execute_tool').map((span) => span.attributes['gen_ai.tool.name']),
    ['lookup', 'book'],
  );
  assertEquals(trial.spans('chat').length, 1);
  assertEquals(trial.spans('generate_content'), []);
});

Deno.test('records with no root, or none at all, are a contract error', async () => {
  const turn = await turnRecord();
  const orphan: TraceRecord = { ...turn, spans: turn.spans.slice(1) };
  assertThrows(() => buildTrial({ suite: 's', index: 0, records: [orphan] }), TheoremError);
  assertThrows(() => buildTrial({ suite: 's', index: 0, records: [] }), TheoremError);
});

Deno.test('groupByTrace keeps records of one trace together, first seen first', async () => {
  const a = await turnRecord({ text: 'a' });
  const b = await turnRecord({ text: 'b' });
  const aMore = await compactionRecord(a);
  const groups = groupByTrace([a, b, aMore]);
  assertEquals([...groups.keys()], [a.spans[0]?.traceId, b.spans[0]?.traceId]);
  assertEquals(groups.get(a.spans[0]?.traceId ?? '')?.length, 2);
});
