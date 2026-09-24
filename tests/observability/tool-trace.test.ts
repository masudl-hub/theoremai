/**
 * `execute_tool` spans: turn tool calls, provider-failed calls, and host invokes.
 */
import '../fixtures/test-host.ts';
import { z } from 'zod';
import { lexiconDefault } from '../../src/guardrails/lexicon.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { sha256 } from '../../src/kernel/engine/hash.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import { defineProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import { invokeTool } from '../../src/kernel/tools/mod.ts';
import { registerTool } from '../../src/kernel/tools/registry.ts';
import type { ModelProvider, TurnEvent } from '../../src/kernel/types.ts';
import { memorySink } from '../../src/observability/trace.ts';
import {
  contentOf,
  inlineContent,
  type TraceRecord,
} from '../../src/observability/trace-record.ts';
import {
  formatTraceparent,
  type TraceAttributes,
  type TraceSpan,
} from '../../src/observability/trace-span.ts';
import { geminiModels } from '../fixtures/models.ts';

const PROFILE = 'tool_trace_probe';
const HOST_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const HOST_SPAN = '00f067aa0ba902b7';
const IMAGE_BASE64 = btoa('tool-image-bytes');
const seenTraceparents: (string | undefined)[] = [];

registerTool({
  type: 'function',
  name: 'tool_trace_image',
  description: 'Returns an image part',
  category: 'test',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
  input: z.object({}),
  output: z.object({
    finding: z.string(),
    parts: z.array(z.object({ type: z.string(), mimeType: z.string(), data: z.string() })),
  }),
  handler: (_input, ctx) => {
    seenTraceparents.push(ctx.traceparent);
    return {
      finding: 'drawn',
      parts: [{ type: 'image', mimeType: 'image/png', data: IMAGE_BASE64 }],
    };
  },
});

registerProfile(
  defineProfile({
    type: 'text',
    identity: { handle: 'test', system: 'test' },
    id: PROFILE,
    ...geminiModels('gemini35FlashLite'),
    maxSteps: 1,
    tools: {
      allow: [
        'lookup_order',
        'crashing_tool',
        'denied_tool',
        'always_confirm_tool',
        'tool_trace_image',
      ],
    },
    inputs: { text: true },
    guardrails: { quota: { perDay: 10_000 } },
  }),
);

/** A provider that asks for `calls` once. */
function asking(...calls: NonNullable<TurnEvent['tool']>[]): ModelProvider {
  return {
    async *complete() {
      for (const tool of calls) yield { type: 'tool', tool };
      yield { type: 'tokens', tokens: { input: 1, output: 0, total: 1 } };
    },
  };
}

async function drain(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

async function turnRecord(...calls: NonNullable<TurnEvent['tool']>[]): Promise<TraceRecord> {
  const into: TraceRecord[] = [];
  await drain(
    runTurn({ profile: PROFILE, input: { text: 'go' } }, asking(...calls), memorySink(into)),
  );
  const [record] = into;
  if (!record) throw new Error('no record');
  return record;
}

function toolSpans(record: TraceRecord): TraceSpan[] {
  return record.spans.filter((span) => span.name.startsWith('execute_tool'));
}

function toolSpan(record: TraceRecord): TraceSpan {
  const [span] = toolSpans(record);
  if (!span) throw new Error('no execute_tool span');
  return span;
}

Deno.test('a tool call is one span under the turn, with what went in and came back', async () => {
  const record = await turnRecord({ id: 'c1', name: 'lookup_order', arguments: { orderId: 'A1' } });
  const [root] = record.spans;
  const span = toolSpan(record);
  assertEquals(span.name, 'execute_tool lookup_order');
  assertEquals(span.parentSpanId, root?.spanId);
  assertEquals(span.status, { code: 'OK' });
  const a = span.attributes;
  assertEquals(a['gen_ai.tool.call.id'], 'c1');
  assertEquals(a['gen_ai.tool.type'], 'function');
  assertEquals(contentOf(record, a['gen_ai.tool.call.arguments']), '{"orderId":"A1"}');
  assertEquals(inlineContent(record, a['theorem.tool.data']), { finding: 'shipped' });
  assertEquals(contentOf(record, a['gen_ai.tool.call.result'])?.includes('shipped'), true);
  assertEquals(
    [
      a['theorem.tool.outcome'],
      a['theorem.tool.origin'],
      a['theorem.tool.permission'],
      a['theorem.step'],
    ],
    ['ok', 'local', 'auto', 1],
  );
  assertEquals(
    span.events.filter((e) => e.name === 'theorem.stage').map((e) => e.attributes.stage),
    ['pre_tool', 'post_tool'],
  );
});

Deno.test('the model reads back the same text the span records', async () => {
  const into: TraceRecord[] = [];
  const seen: string[] = [];
  const provider: ModelProvider = {
    async *complete(req) {
      const tool = req.history?.findLast((m) => m.role === 'tool');
      if (tool?.content) {
        seen.push(tool.content);
        yield { type: 'text', text: 'done' };
        return;
      }
      yield {
        type: 'tool',
        tool: { id: 'c1', name: 'lookup_order', arguments: { orderId: 'A1' } },
      };
    },
  };
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: `${PROFILE}_2`,
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 2,
      tools: { allow: ['lookup_order'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10_000 } },
    }),
  );
  await drain(
    runTurn({ profile: `${PROFILE}_2`, input: { text: 'go' } }, provider, memorySink(into)),
  );
  const [record] = into;
  if (!record) throw new Error('no record');
  assertEquals(contentOf(record, toolSpan(record).attributes['gen_ai.tool.call.result']), seen[0]);
});

Deno.test('a failing tool is ERROR with its kind and code and no raw output', async () => {
  const span = toolSpan(
    await turnRecord({ id: 'c1', name: 'crashing_tool', arguments: { id: '1' } }),
  );
  assertEquals(span.status, { code: 'ERROR', message: 'failed' });
  assertEquals(span.attributes['theorem.tool.outcome'], 'error');
  assertEquals(span.attributes['error.type'], 'failed');
  assertEquals(span.attributes['theorem.tool.failure.code'], 'handler_error');
  assertEquals('theorem.tool.data' in span.attributes, false);
  assertEquals('gen_ai.tool.call.result' in span.attributes, true);
});

Deno.test('a provider error types the turn and the call by its kind', async () => {
  const into: TraceRecord[] = [];
  const failing: ModelProvider = {
    async *complete() {
      yield { type: 'error', errorKind: 'rate_limit', errorInternal: 'upstream 429' };
    },
  };
  await drain(runTurn({ profile: PROFILE, input: { text: 'go' } }, failing, memorySink(into)));
  const [record] = into;
  const [root] = record?.spans ?? [];
  const call = record?.spans.find((span) => span.name.startsWith('generate_content'));
  assertEquals(root?.attributes['error.type'], 'rate_limit');
  assertEquals(root?.status, { code: 'ERROR', message: 'rate_limit' });
  assertEquals(call?.attributes['error.type'], 'rate_limit');
  assertEquals(
    record && contentOf(record, root?.attributes['theorem.error.public']),
    lexiconDefault('error.rate_limit'),
  );
});

Deno.test('a denied call is UNSET, not a failure', async () => {
  const span = toolSpan(await turnRecord({ id: 'c1', name: 'denied_tool', arguments: {} }));
  assertEquals(span.status, { code: 'UNSET' });
  assertEquals(span.attributes['theorem.tool.outcome'], 'denied');
  assertEquals('error.type' in span.attributes, false);
});

Deno.test('a gated call records the gate and nothing read back', async () => {
  const span = toolSpan(await turnRecord({ id: 'c1', name: 'always_confirm_tool', arguments: {} }));
  assertEquals(span.status, { code: 'UNSET' });
  assertEquals(span.attributes['theorem.tool.outcome'], 'gated');
  assertEquals(span.attributes['theorem.tool.permission'], 'always_confirm');
  assertEquals('gen_ai.tool.call.result' in span.attributes, false);
  const gate = span.events.find((e) => e.name === 'theorem.gate');
  assertEquals(gate?.attributes.kind, 'permission');
});

Deno.test('malformed arguments are recorded as the raw text the model sent', async () => {
  const raw = '{"orderId": "A1';
  const record = await turnRecord({
    id: 'c1',
    name: 'lookup_order',
    arguments: {},
    phase: 'error',
    failure: {
      code: 'malformed_arguments',
      kind: 'bad_response',
      message: 'bad json',
      details: { raw },
    },
  });
  const span = toolSpan(record);
  assertEquals(span.status, { code: 'ERROR', message: 'bad_response' });
  assertEquals(span.attributes['error.type'], 'bad_response');
  assertEquals(span.attributes['theorem.tool.failure.code'], 'malformed_arguments');
  assertEquals(contentOf(record, span.attributes['gen_ai.tool.call.arguments']), raw);
  assertEquals('gen_ai.tool.call.result' in span.attributes, true);
});

Deno.test('tool media is hashed in the raw output and the result parts', async () => {
  seenTraceparents.length = 0;
  const record = await turnRecord({ id: 'c1', name: 'tool_trace_image', arguments: {} });
  const span = toolSpan(record);
  const hash = await sha256('tool-image-bytes');
  const data = JSON.parse(contentOf(record, span.attributes['theorem.tool.data']) ?? 'null');
  assertEquals(data.parts[0], {
    type: 'image',
    mimeType: 'image/png',
    data: hash,
    dataKind: 'sha256',
  });
  const [part] = span.attributes['theorem.tool.call.result.parts'] as TraceAttributes[];
  assertEquals(part?.content_sha256, hash);
  assertEquals(JSON.stringify(record).includes(IMAGE_BASE64), false);
  assertEquals(seenTraceparents, [formatTraceparent(span.traceId, span.spanId)]);
});

Deno.test('a host invoke writes its own record, rooted under the host span', async () => {
  const into: TraceRecord[] = [];
  const events = await drain(
    invokeTool(
      {
        profile: PROFILE,
        name: 'always_confirm_tool',
        input: {},
        resume: { granted: true },
        traceparent: formatTraceparent(HOST_TRACE, HOST_SPAN),
        conversationId: 'conv_1',
        metadata: { user: 'u_1' },
      },
      memorySink(into),
    ),
  );
  const [record] = into;
  const [root] = record?.spans ?? [];
  assertEquals(record?.spans.length, 1);
  assertEquals(record?.metadata, { user: 'u_1' });
  assertEquals(root?.name, 'execute_tool always_confirm_tool');
  assertEquals([root?.traceId, root?.parentSpanId], [HOST_TRACE, HOST_SPAN]);
  assertEquals(root?.attributes['gen_ai.agent.name'], PROFILE);
  assertEquals(root?.attributes['gen_ai.conversation.id'], 'conv_1');
  assertEquals(root?.attributes['theorem.tool.approved'], true);
  assertEquals(root?.attributes['theorem.tool.outcome'], 'ok');
  assertEquals(
    events.findLast((e) => e.type === 'done')?.traceparent,
    formatTraceparent(HOST_TRACE, root?.spanId ?? ''),
  );
});

Deno.test('a host invoke that fails before the tool still records why', async () => {
  const into: TraceRecord[] = [];
  let thrown = false;
  try {
    await drain(
      invokeTool(
        { profile: 'no_such_profile', name: 'lookup_order', input: { orderId: 'A1' } },
        memorySink(into),
      ),
    );
  } catch {
    thrown = true;
  }
  const root = into[0]?.spans[0];
  assertEquals(thrown, true);
  assertEquals(root?.status.code, 'ERROR');
  assertEquals(root?.attributes['theorem.tool.outcome'], 'error');
  assertEquals(
    root?.events.some((e) => e.name === 'exception'),
    true,
  );
  assertEquals(
    into[0] && contentOf(into[0], root?.attributes['gen_ai.tool.call.arguments']),
    '{"orderId":"A1"}',
  );
});
