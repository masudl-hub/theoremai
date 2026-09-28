/**
 * OpenInference names: usage on model calls only (never a partial cost),
 * messages and values the way Phoenix reads them, and decisions as LLM spans.
 */
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import {
  clearProfiles,
  defineProfile,
  registerProfile,
  runDecision,
} from '../../src/kernel/mod.ts';
import { withOpenInference } from '../../src/observability/openinference.ts';
import { memorySink } from '../../src/observability/trace.ts';
import type { TraceRecord } from '../../src/observability/trace-record.ts';
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

Deno.test('withOpenInference flattens a model call’s messages the way Phoenix reads them', () => {
  const record: TraceRecord = {
    ...stubRecord(),
    content: {
      sys: 'Translate what the person gives you.',
      ask: 'Translate to Spanish: The kettle is on.',
      args: '{"q":"kettle"}',
      reply: 'La tetera está puesta.',
      out: '{"lang":"es"}',
    },
    spans: [
      {
        ...stubSpan(),
        attributes: {
          'gen_ai.operation.name': 'generate_content',
          'gen_ai.system_instructions': [{ type: 'text', content_sha256: 'sys' }],
          'gen_ai.input.messages': [
            { role: 'user', parts: [{ type: 'text', content_sha256: 'ask' }] },
            {
              role: 'assistant',
              parts: [
                {
                  type: 'tool_call',
                  id: 'c1',
                  name: 'lookup',
                  arguments: { content_sha256: 'args' },
                },
              ],
            },
            {
              role: 'tool',
              parts: [
                { type: 'tool_call_response', id: 'c1', response: { content_sha256: 'reply' } },
              ],
            },
          ],
          'gen_ai.output.messages': [
            {
              role: 'assistant',
              parts: [
                { type: 'text', content_sha256: 'reply' },
                { type: 'structured', content: { json_sha256: 'out' } },
              ],
            },
          ],
        },
      },
    ],
  };
  const attributes = withOpenInference([record])[0]?.spans[0]?.attributes ?? {};
  assertEquals(attributes['llm.input_messages.0.message.role'], 'system');
  assertEquals(
    attributes['llm.input_messages.0.message.content'],
    'Translate what the person gives you.',
  );
  assertEquals(attributes['llm.input_messages.1.message.role'], 'user');
  assertEquals(
    attributes['llm.input_messages.1.message.content'],
    'Translate to Spanish: The kettle is on.',
  );
  assertEquals(attributes['llm.input_messages.2.message.tool_calls.0.tool_call.id'], 'c1');
  assertEquals(
    attributes['llm.input_messages.2.message.tool_calls.0.tool_call.function.name'],
    'lookup',
  );
  assertEquals(
    attributes['llm.input_messages.2.message.tool_calls.0.tool_call.function.arguments'],
    '{"q":"kettle"}',
  );
  assertEquals('llm.input_messages.2.message.content' in attributes, false);
  assertEquals(attributes['llm.input_messages.3.message.role'], 'tool');
  assertEquals(attributes['llm.input_messages.3.message.tool_call_id'], 'c1');
  assertEquals(attributes['llm.input_messages.3.message.content'], 'La tetera está puesta.');
  assertEquals(
    attributes['llm.output_messages.0.message.content'],
    'La tetera está puesta.\n{"lang":"es"}',
  );
  // Several input messages: the value is their JSON; one output message: its text.
  assertEquals(attributes['input.mime_type'], 'application/json');
  assertEquals(
    JSON.parse(String(attributes['input.value'])).map((m: { role: string }) => m.role),
    ['user', 'assistant', 'tool'],
  );
  assertEquals(attributes['output.value'], 'La tetera está puesta.\n{"lang":"es"}');
  assertEquals(attributes['output.mime_type'], 'text/plain');
  // The semconv names stay.
  assertEquals(Array.isArray(attributes['gen_ai.input.messages']), true);
});

Deno.test('withOpenInference shows a structured answer once when the model’s text is that same JSON', () => {
  const record: TraceRecord = {
    ...stubRecord(),
    content: {
      typed: '{\n  "lang": "es",\n  "text": "Hola"\n}',
      json: '{"lang":"es","text":"Hola"}',
    },
    spans: [
      {
        ...stubSpan(),
        attributes: {
          'gen_ai.operation.name': 'invoke_agent',
          'gen_ai.output.messages': [
            {
              role: 'assistant',
              parts: [
                { type: 'text', content_sha256: 'typed' },
                { type: 'structured', content: { json_sha256: 'json' } },
              ],
            },
          ],
        },
      },
    ],
  };
  const attributes = withOpenInference([record])[0]?.spans[0]?.attributes ?? {};
  assertEquals(attributes['output.value'], '{"lang":"es","text":"Hola"}');
});

Deno.test('withOpenInference gives a turn its input and output values, names media, and reads Live’s delivered parts', () => {
  const record: TraceRecord = {
    ...stubRecord(),
    content: { ask: 'Describe this.', said: 'Hello there.' },
    spans: [
      {
        ...stubSpan(),
        attributes: {
          'gen_ai.operation.name': 'invoke_agent',
          'gen_ai.input.messages': [
            {
              role: 'user',
              parts: [
                { type: 'text', content_sha256: 'ask' },
                { type: 'blob', modality: 'image', mime_type: 'image/png', bytes_sha256: 'x' },
              ],
            },
          ],
          'gen_ai.output.messages': [{ role: 'assistant', parts: [] }],
        },
      },
      {
        ...stubSpan(),
        attributes: {
          'gen_ai.operation.name': 'generate_content',
          'theorem.output.delivered': [
            {
              role: 'assistant',
              parts: [
                { type: 'text', content_sha256: 'said', 'theorem.source': 'output_transcription' },
              ],
            },
          ],
        },
      },
    ],
  };
  const [turn, live] = withOpenInference([record])[0]?.spans ?? [];
  assertEquals(turn?.attributes['input.value'], 'Describe this.\n[image]');
  assertEquals(turn?.attributes['input.mime_type'], 'text/plain');
  // An output with nothing readable is written as its JSON, not left out.
  assertEquals(turn?.attributes['output.value'], '[{"role":"assistant","content":""}]');
  assertEquals('llm.input_messages.0.message.role' in (turn?.attributes ?? {}), false);
  assertEquals(live?.attributes['llm.output_messages.0.message.content'], 'Hello there.');
  assertEquals(live?.attributes['output.value'], 'Hello there.');
  assertEquals('input.value' in (live?.attributes ?? {}), false);
});

Deno.test('withOpenInference shows a decision as an LLM span: its state in, its answers out', async () => {
  clearProfiles();
  registerProfile(
    defineProfile({
      type: 'decision',
      id: 'oi-decision',
      identity: { handle: 'Decision' },
      models: { jev: { apiId: 'jev-latest' } },
      inputs: { state: 'json' },
      decision: { contract: 'oi.v1' },
    }),
  );
  const records: TraceRecord[] = [];
  const questions = {
    verdict: {
      type: 'choice' as const,
      instructions: 'Is it right?',
      criteria: { yes: 'It is right.', no: 'It is wrong.' },
    },
  };
  const answers = {
    verdict: {
      type: 'choice',
      choice: 'yes',
      confidence: 0.8,
      probabilities: { yes: 0.9, no: 0.1 },
    },
  };
  await runDecision(
    { profile: 'oi-decision', state: { output: 'hola' }, questions },
    {
      apiKey: 'test-key',
      sink: memorySink(records),
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              model: 'jev-1.13.0',
              answers,
              usage: { input_tokens: 40, output_tokens: 3 },
            }),
          ),
        ),
    },
  );
  const [span] = withOpenInference(records)[0]?.spans ?? [];
  const attributes = span?.attributes ?? {};
  assertEquals(
    Object.fromEntries(
      Object.entries(attributes).filter(
        ([key]) =>
          key.startsWith('openinference.') ||
          key.startsWith('llm.') ||
          key.startsWith('input.') ||
          key.startsWith('output.'),
      ),
    ),
    {
      'openinference.span.kind': 'LLM',
      'llm.model_name': 'jev-1.13.0',
      'llm.provider': 'typesafe',
      'llm.token_count.prompt': 40,
      'llm.token_count.completion': 3,
      'llm.token_count.total': 43,
      'input.value': JSON.stringify({ output: 'hola' }),
      'input.mime_type': 'application/json',
      'output.value': JSON.stringify(answers),
      'output.mime_type': 'application/json',
    },
  );
});
