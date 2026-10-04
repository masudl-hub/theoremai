import { assert, assertEquals } from '@std/assert';
import { traceLatency } from '../../react/src/client/trace-story.ts';
import {
  filterTraceTree,
  TRACE_TEXT_FIELD,
  type TraceFilter,
  traceSearchFields,
  traceSpans,
  traceTotals,
  traceTree,
  traceValueShape,
} from '../../react/src/client/trace-view.ts';
import { traceAttributeMeta } from '../../src/observability/trace-catalog.ts';
import type { TraceRecord } from '../../src/observability/trace-record.ts';
import type { TraceSpan } from '../../src/observability/trace-span.ts';
import { stubRecord, stubSpan } from '../fixtures/trace-record.ts';

const MS = 1_000_000;

function span(
  id: string,
  parent: string | undefined,
  startMs: number,
  endMs: number,
  attributes: TraceSpan['attributes'],
  status: TraceSpan['status']['code'] = 'OK',
): TraceSpan {
  return {
    ...stubSpan(),
    spanId: id,
    ...(parent ? { parentSpanId: parent } : {}),
    startTimeUnixNano: String(startMs * MS),
    endTimeUnixNano: String(endMs * MS),
    attributes,
    status: { code: status },
  };
}

function record(spans: TraceSpan[], content: Record<string, string> = {}): TraceRecord {
  return { ...stubRecord(), spans, content };
}

const TURN = { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'chat' };

function call(model: string, usage: TraceSpan['attributes']): TraceSpan['attributes'] {
  return { 'gen_ai.operation.name': 'generate_content', 'gen_ai.request.model': model, ...usage };
}

const turn = record(
  [
    span('root', undefined, 0, 900, { ...TURN, 'gen_ai.usage.input_tokens': 999 }),
    span('c2', 'root', 400, 800, call('m-2', { 'gen_ai.usage.input_tokens': 20 }), 'ERROR'),
    span('c1', 'root', 10, 300, {
      ...call('m-1', {
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 7,
        'theorem.usage.cost_usd': 0.5,
        'theorem.usage.estimated': ['output'],
      }),
      'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content_sha256: 'h1' }] }],
    }),
  ],
  { h1: 'Water the fern' },
);

Deno.test('the tree nests spans across records in start order, and a late parent adopts its children', () => {
  const response = record([
    span('r1', 'session', 50, 60, call('live', { 'theorem.request.live': {} })),
  ]);
  const before = traceTree([response]);
  assertEquals(
    before.map((node) => node.span.spanId),
    ['r1'],
  );
  const session = record([span('session', undefined, 0, 100, TURN)]);
  const after = traceTree([response, turn, session]);
  assertEquals(
    after.map((node) => node.span.spanId),
    ['root', 'session'],
  );
  assertEquals(
    after[0]?.children.map((node) => node.span.spanId),
    ['c1', 'c2'],
  );
  assertEquals(
    after[1]?.children.map((node) => node.meta.type),
    ['response'],
  );
  assertEquals(after[0]?.durationMs, 900);
});

Deno.test('totals sum the model calls, not the root, and say what is partial or estimated', () => {
  const totals = traceTotals(traceTree([turn]));
  assertEquals(totals, {
    spans: 3,
    errors: 1,
    durationMs: 900,
    calls: 2,
    input: { value: 120, complete: true, estimated: false },
    output: { value: 7, complete: false, estimated: true },
    cost: { value: 0.5, complete: false },
  });
  assertEquals(traceTotals([]).input, undefined);
});

Deno.test('search fields are worded by the catalog and list the values seen', () => {
  const fields = traceSearchFields(traceTree([turn]));
  const byKey = new Map(fields.map((field) => [field.key, field]));
  assertEquals(
    byKey.get('type')?.options?.map((option) => option.label),
    ['Model call', 'Turn'],
  );
  assertEquals(
    byKey.get('status')?.options?.map((option) => option.value),
    ['ERROR', 'OK'],
  );
  assertEquals(byKey.get('gen_ai.usage.input_tokens')?.label, 'Input tokens');
  assertEquals(byKey.get('gen_ai.usage.input_tokens')?.group, 'Usage');
  assertEquals(byKey.get('theorem.usage.estimated')?.options, [
    {
      value: 'output',
      label: 'Output',
      doc: byKey.get('theorem.usage.estimated')?.options?.[0]?.doc,
    },
  ]);
  assertEquals(byKey.has('gen_ai.input.messages'), false);
});

Deno.test('filters keep matching spans under their ancestors and search stored text', () => {
  const tree = traceTree([turn]);
  const errors: TraceFilter[] = [
    { field: 'status', operator: 'isAnyOf', value: { type: 'enum_list', value: ['ERROR'] } },
  ];
  const cut = filterTraceTree(tree, errors);
  assertEquals(cut.matches, 1);
  assertEquals(
    traceSpans(cut.nodes).map((node) => node.span.spanId),
    ['root', 'c2'],
  );
  const fern: TraceFilter[] = [
    { field: TRACE_TEXT_FIELD, operator: 'contains', value: { type: 'string', value: 'FERN' } },
  ];
  assertEquals(
    traceSpans(filterTraceTree(tree, fern).nodes).map((node) => node.span.spanId),
    ['root', 'c1'],
  );
  const slow: TraceFilter[] = [
    { field: 'duration', operator: 'greaterThan', value: { type: 'float', value: 350 } },
    { field: 'gen_ai.request.model', operator: 'contains', value: { type: 'string', value: 'm-' } },
  ];
  assertEquals(filterTraceTree(tree, slow).matches, 1);
  assertEquals(filterTraceTree(tree, []).matches, 3);
});

Deno.test('a value shows by its catalog format first, then by its shape', () => {
  const messages = traceAttributeMeta('gen_ai.input.messages');
  assertEquals(traceValueShape(messages, 'hi'), { kind: 'stored' });
  assertEquals(traceValueShape(undefined, 'hi'), { kind: 'text', value: 'hi' });
  assertEquals(traceValueShape(undefined, 3), { kind: 'scalar', value: 3 });
  assertEquals(traceValueShape(undefined, false), { kind: 'scalar', value: false });
  assertEquals(traceValueShape(undefined, ['a', 'b']), { kind: 'list', value: ['a', 'b'] });
  assertEquals(traceValueShape(undefined, { a: 1 }), { kind: 'stored' });
  const fields = {
    a: { label: 'A', doc: 'The a.', format: 'text' as const, group: 'record' as const },
  };
  const object = {
    label: 'O',
    doc: 'An object.',
    format: 'object' as const,
    group: 'record' as const,
    fields,
  };
  assertEquals(traceValueShape(object, { a: 1 }), { kind: 'fields', fields, items: [{ a: 1 }] });
  assertEquals(traceValueShape(object, [{ a: 1 }, { a: 2 }]), {
    kind: 'fields',
    fields,
    items: [{ a: 1 }, { a: 2 }],
  });
  assertEquals(traceValueShape(object, [1, { a: 2 }]), { kind: 'stored' });
});

Deno.test('traceLatency reads first text, holdback, writing speed and guardrail time', () => {
  const guardrail = (action: string, duration_ms?: number) => ({
    name: 'theorem.guardrail',
    timeUnixNano: '0',
    attributes: {
      stage: 'input',
      trust: 'untrusted',
      action,
      hits: [],
      ...(duration_ms === undefined ? {} : { duration_ms }),
    },
  });
  const [root] = traceTree([
    record([
      {
        ...span('root', undefined, 0, 1000, { ...TURN, 'theorem.turn.time_to_first_text': 0.5 }),
        events: [guardrail('allow', 2), guardrail('flag')],
      },
      span(
        'c1',
        'root',
        100,
        900,
        call('m', {
          'theorem.response.time_to_first_text': 0.2,
          'gen_ai.usage.output_tokens': 60,
          'theorem.guardrail.stream_ms': 3,
        }),
      ),
    ]),
  ]);
  assert(root);
  const latency = traceLatency(root);
  assertEquals(latency.firstTextMs, 500);
  // The model first wrote at 300 ms; the person saw it at 500 ms.
  assertEquals(latency.heldMs, 200);
  // 60 tokens over the 600 ms from first text to the call's end.
  assertEquals(latency.tokensPerSecond, 100);
  assertEquals(latency.guardrails, { checks: 2, ms: 5, flagged: 1 });
});

Deno.test("traceLatency counts a call's stream checks once, beside the call's total of them", () => {
  const stream = (check: string, duration_ms: number) => ({
    name: 'theorem.guardrail',
    timeUnixNano: '0',
    attributes: {
      stage: 'output_delta',
      trust: 'untrusted',
      action: 'allow',
      hits: [],
      check,
      duration_ms,
      runs: 4,
    },
  });
  const [root] = traceTree([
    record([
      span('root', undefined, 0, 1000, TURN),
      {
        ...span('c1', 'root', 100, 900, call('m', { 'theorem.guardrail.stream_ms': 5 })),
        events: [stream('output_stream', 3), stream('stream_canary', 2)],
      },
    ]),
  ]);
  assert(root);
  assertEquals(traceLatency(root).guardrails, { checks: 2, ms: 5, flagged: 0 });
});

Deno.test('traceLatency leaves out what the trace did not record', () => {
  const [root] = traceTree([record([span('root', undefined, 0, 100, TURN)])]);
  assert(root);
  assertEquals(traceLatency(root), {});
});
