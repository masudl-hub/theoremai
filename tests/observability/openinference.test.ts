/**
 * OpenInference usage names: model calls only, never a partial cost.
 */
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { withOpenInference } from '../../src/observability/openinference.ts';
import type { TraceAttributes } from '../../src/observability/trace-span.ts';
import { stubRecord, stubSpan } from '../fixtures/trace-record.ts';

function recordWith(...spans: TraceAttributes[]) {
  return { ...stubRecord(), spans: spans.map((attributes) => ({ ...stubSpan(), attributes })) };
}

Deno.test('withOpenInference copies reasoning tokens and cost onto model calls', () => {
  const record = recordWith(
    {
      'gen_ai.operation.name': 'chat',
      'gen_ai.usage.reasoning.output_tokens': 423,
      'theorem.usage.cost_usd': 0.0021,
    },
    { 'gen_ai.operation.name': 'generate_content', 'gen_ai.usage.reasoning.output_tokens': 506 },
  );
  const [chat, generate] = withOpenInference([record])[0]?.spans ?? [];
  assertEquals(chat?.attributes['llm.token_count.completion_details.reasoning'], 423);
  assertEquals(chat?.attributes['llm.cost.total'], 0.0021);
  assertEquals(generate?.attributes['llm.token_count.completion_details.reasoning'], 506);
  // Google reports no cost, so none is written.
  assertEquals('llm.cost.total' in (generate?.attributes ?? {}), false);
});

Deno.test('withOpenInference leaves agent and tool spans, and partial costs, alone', () => {
  const agent = { 'gen_ai.operation.name': 'invoke_agent', 'theorem.usage.cost_usd': 0.5 };
  const tool = { 'gen_ai.operation.name': 'execute_tool' };
  const partial = {
    'gen_ai.operation.name': 'chat',
    'theorem.usage.cost_usd': 0.1,
    'theorem.usage.cost_partial': true,
  };
  const record = recordWith(agent, tool, partial);
  const [out] = withOpenInference([record]);
  assertEquals(
    out?.spans.map((span) => span.attributes),
    [agent, tool, partial],
  );
  // The input record is not changed.
  assertEquals(record.spans[2]?.attributes, partial);
});
