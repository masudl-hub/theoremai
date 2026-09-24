import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { startCallUsage } from '../../src/kernel/engine/runner/usage.ts';
import { OutputFold, startCallTrace, usageAttributes } from '../../src/kernel/engine/turn-trace.ts';
import type { ModelBinding, ProviderCompleteRequest, TurnEvent } from '../../src/kernel/types.ts';
import {
  type SpanHandle,
  type SpanOptions,
  startTrace,
  type TraceAttributes,
  type TraceSpan,
  type TraceTree,
  traceContent,
} from '../../src/observability/trace-span.ts';

// Values are synthetic. One clock tick is one millisecond.
const NANOS_PER_TICK = 1_000_000n;
const HTTP_QUOTA = 429;
const HTTP_OK = 200;

function tickingClock() {
  let tick = 0n;
  return {
    nowUnixNano: () => {
      tick += 1n;
      return tick * NANOS_PER_TICK;
    },
  };
}

const binding: ModelBinding = {
  protocol: 'geminiInteractions',
  provider: 'google',
  apiId: 'gemini-test-flash',
} as ModelBinding;

function request(over: Partial<ProviderCompleteRequest> = {}): ProviderCompleteRequest {
  return {
    model: 'flash',
    apiId: 'gemini-test-flash',
    builtins: [],
    system: 'Be brief.',
    input: [{ type: 'text', text: 'Check soil' }],
    structured: null,
    image: null,
    stream: true,
    thinking: 'low',
    ...over,
  };
}

function trace() {
  return startTrace('invoke_agent chat', { clock: tickingClock(), kind: 'INTERNAL' });
}

/** Opens each call span as a child of the turn root, as a turn does. */
function under(tree: TraceTree): (name: string, options: SpanOptions) => SpanHandle {
  return (name, options) => tree.root.child(name, options);
}

function spanNamed(spans: TraceSpan[], name: string): TraceSpan {
  const span = spans.find((s) => s.name === name);
  if (!span) {
    throw new Error(`no span ${name}`);
  }
  return span;
}

function attrs(span: TraceSpan): TraceAttributes {
  return span.attributes;
}

Deno.test('turn trace: a call records what the model read and wrote, before guardrails', () => {
  const tree = trace();
  const usage = startCallUsage('Be brief.', {
    history: [{ role: 'user', content: 'Hi' }],
    input: [{ type: 'text', text: 'Check soil' }],
  });
  const call = startCallTrace(under(tree), {
    req: request(),
    usage,
    binding,
    transport: 'interactions',
    step: 0,
    attempt: 0,
  });
  const events: TurnEvent[] = [
    { type: 'thought', text: 'Soil ' },
    { type: 'thought', text: 'first.' },
    { type: 'text', text: 'Checking ' },
    { type: 'text', text: 'now.' },
    { type: 'response', response: { id: 'v1_a' } },
    { type: 'tool', tool: { id: 'c1', name: 'fetch_sensor', arguments: { plant: 'fern' } } },
    { type: 'done', stop: { kind: 'tool', native: 'requires_action' } },
  ];
  for (const event of events) {
    call.observe(event);
  }
  call.end({ tokens: { input: 10, output: 4, total: 14 }, stop: { kind: 'tool' } });
  const span = spanNamed(tree.collect(), 'generate_content gemini-test-flash');
  const a = attrs(span);
  assertEquals(span.kind, 'CLIENT');
  assertEquals(span.status, { code: 'OK' });
  assertEquals(a['gen_ai.provider.name'], 'gcp.gemini');
  assertEquals(a['gen_ai.request.reasoning.level'], 'low');
  assertEquals(a['gen_ai.output.type'], 'text');
  assertEquals(a['gen_ai.input.messages'], [
    { role: 'user', parts: [{ type: 'text', ...traceContent('Hi') }] },
    { role: 'user', parts: [{ type: 'text', ...traceContent('Check soil') }] },
  ]);
  assertEquals(a['gen_ai.output.messages'], [
    {
      role: 'assistant',
      parts: [
        { type: 'reasoning', ...traceContent('Soil first.') },
        { type: 'text', ...traceContent('Checking now.') },
        {
          type: 'tool_call',
          id: 'c1',
          name: 'fetch_sensor',
          arguments: traceContent('{"plant":"fern"}'),
        },
      ],
      finish_reason: 'tool_call',
    },
  ]);
  assertEquals(a['gen_ai.response.id'], 'v1_a');
  assertEquals(a['gen_ai.response.status'], 'requires_action');
  assertEquals(a['theorem.stop.kind'], 'tool');
  assertEquals(a['gen_ai.usage.input_tokens'], 10);
  assertEquals(Object.hasOwn(a, 'theorem.input.sent_from'), false);
});

Deno.test('turn trace: a tool call is one part; its execution phases add none', () => {
  const fold = new OutputFold();
  const call = { callId: 'c1', name: 'fetch_sensor', arguments: { plant: 'fern' } };
  const events: TurnEvent[] = [
    { type: 'text', text: 'Checking.' },
    { type: 'tool', tool: call },
    { type: 'tool', tool: { ...call, phase: 'running' } },
    { type: 'tool', tool: { ...call, phase: 'complete', output: { moisture: 0.4 } } },
    { type: 'text', text: 'Moist.' },
  ];
  for (const event of events) {
    fold.add(event, '1');
  }
  assertEquals(fold.parts, [
    { type: 'text', ...traceContent('Checking.') },
    { type: 'tool_call', name: 'fetch_sensor', arguments: traceContent('{"plant":"fern"}') },
    { type: 'text', ...traceContent('Moist.') },
  ]);
});

Deno.test('turn trace: a continuation reads the stored interaction and marks where the wire starts', () => {
  const tree = trace();
  const first = startCallUsage('s', { history: [], input: [{ type: 'text', text: 'Hi' }] });
  const one = startCallTrace(under(tree), {
    req: request(),
    usage: first,
    binding,
    transport: 'interactions',
    step: 0,
    attempt: 0,
  });
  one.observe({ type: 'text', text: 'Hello' });
  one.end({ stop: { kind: 'completed' } });
  const second = startCallUsage('s', {
    previous: first,
    continuation: [{ role: 'user', content: 'More' }],
  });
  const two = startCallTrace(under(tree), {
    req: request({ previousInteractionId: 'v1_a' }),
    usage: second,
    binding,
    transport: 'interactions',
    step: 1,
    attempt: 0,
  });
  two.end({ stop: { kind: 'completed' } });
  const [, , span] = tree.collect();
  assertEquals(attrs(span as TraceSpan)['gen_ai.input.messages'], [
    { role: 'user', parts: [{ type: 'text', ...traceContent('Hi') }] },
    {
      role: 'assistant',
      parts: [{ type: 'text', ...traceContent('Hello') }],
      finish_reason: 'stop',
    },
    { role: 'user', parts: [{ type: 'text', ...traceContent('More') }] },
  ]);
  assertEquals(attrs(span as TraceSpan)['theorem.input.sent_from'], 2);
  assertEquals(attrs(span as TraceSpan)['gen_ai.request.previous_response.id'], 'v1_a');
});

Deno.test('turn trace: each HTTP try is a POST span with its slot, body and backoff', () => {
  const tree = trace();
  const call = startCallTrace(under(tree), {
    req: request(),
    usage: startCallUsage('s', { history: [], input: [] }),
    binding,
    transport: 'interactions',
    step: 0,
    attempt: 0,
  });
  const url = 'https://api.example/v1/interactions?key=secret';
  const body = { stream: true };
  call.tap({ eventType: 'http_request', method: 'POST', url, keySlot: 'slotA', body });
  call.tap({ eventType: 'http_response', status: HTTP_QUOTA, headers: {} });
  call.tap({ eventType: 'http_error_body', body: 'quota' });
  call.tap({ eventType: 'http_request', method: 'POST', url, keySlot: 'paid', body });
  call.tap({ eventType: 'http_response', status: HTTP_OK, headers: {} });
  call.tap({ event_type: 'interaction.created' });
  call.end({ stop: { kind: 'completed' } });
  const spans = tree.collect();
  const posts = spans.filter((s) => s.name === 'POST');
  assertEquals(posts.length, 2);
  const [quota, ok] = posts as [TraceSpan, TraceSpan];
  assertEquals(attrs(quota)['url.path'], '/v1/interactions');
  assertEquals(attrs(quota)['server.address'], 'api.example');
  assertEquals(attrs(quota)['theorem.key_slot'], 'slotA');
  assertEquals(attrs(quota)['http.response.status_code'], HTTP_QUOTA);
  assertEquals(attrs(quota)['error.type'], String(HTTP_QUOTA));
  assertEquals(quota.status.code, 'ERROR');
  assertEquals(
    quota.events.map((e) => e.name),
    ['theorem.wire.request', 'theorem.upstream.row'],
  );
  assertEquals(attrs(ok)['http.request.resend_count'], 1);
  assertEquals(attrs(ok)['theorem.key_slot'], 'paid');
  assertEquals(typeof attrs(ok)['theorem.retry.backoff_ms'], 'number');
  assertEquals(ok.status.code, 'OK');
  const chat = spanNamed(spans, 'generate_content gemini-test-flash');
  assertEquals(
    chat.events.map((e) => e.name),
    ['theorem.upstream.row'],
  );
  assertEquals(attrs(chat)['gen_ai.request.stream'], true);
  assertEquals(typeof attrs(chat)['gen_ai.response.time_to_first_chunk'], 'number');
  assertEquals(attrs(chat)['theorem.key_slot'], 'paid');
});

Deno.test('turn trace: a buffered body is not streaming, whatever the request asked', () => {
  const tree = trace();
  const call = startCallTrace(under(tree), {
    req: request({ stream: true }),
    usage: startCallUsage('s', { history: [], input: [] }),
    binding,
    transport: 'openAiCompat',
    step: 0,
    attempt: 0,
  });
  call.tap({
    eventType: 'http_request',
    method: 'POST',
    url: 'https://api.example/v1/images',
    body: { model: 'image-test' },
  });
  call.tap({ eventType: 'http_response', status: HTTP_OK, headers: {} });
  call.tap({ data: [{ b64_json: 'aGk=' }] });
  call.end({ stop: { kind: 'completed' } });
  const chat = spanNamed(tree.collect(), 'chat gemini-test-flash');
  assertEquals(attrs(chat)['gen_ai.request.stream'], undefined);
  assertEquals(attrs(chat)['gen_ai.response.time_to_first_chunk'], undefined);
});

Deno.test('turn trace: a provider error fails the call; a cancel leaves it unset with no finish', () => {
  const tree = trace();
  const failed = startCallTrace(under(tree), {
    req: request(),
    usage: startCallUsage('s', { history: [], input: [] }),
    binding,
    transport: 'interactions',
    step: 0,
    attempt: 0,
  });
  failed.tap({ eventType: 'http_request', method: 'POST', url: 'https://api.example/x' });
  failed.tap({ eventType: 'http_response', status: 500, headers: {} });
  failed.observe({ type: 'error', errorKind: 'unavailable', errorInternal: 'upstream 500' });
  failed.end({ stop: { kind: 'provider_error' } });
  const cancelled = startCallTrace(under(tree), {
    req: request(),
    usage: startCallUsage('s', { history: [], input: [] }),
    binding,
    transport: 'interactions',
    step: 0,
    attempt: 1,
  });
  cancelled.observe({ type: 'text', text: 'Part' });
  cancelled.end({ stop: { kind: 'cancelled' } });
  const calls = tree.collect().filter((s) => s.name.startsWith('generate_content'));
  const [bad, stopped] = calls as [TraceSpan, TraceSpan];
  assertEquals(bad.status, { code: 'ERROR', message: 'unavailable' });
  assertEquals(attrs(bad)['error.type'], 'unavailable');
  const [post] = tree.collect().filter((s) => s.parentSpanId === bad.spanId && s.name === 'POST');
  assertEquals(attrs(post as TraceSpan)['error.type'], '500');
  assertEquals(
    bad.events.map((e) => e.name),
    ['exception'],
  );
  assertEquals(stopped.status, { code: 'UNSET' });
  assertEquals(attrs(stopped)['gen_ai.output.messages'], [
    { role: 'assistant', parts: [{ type: 'text', ...traceContent('Part') }] },
  ]);
});

Deno.test('turn trace: provider-run tool steps are server tool parts; citations are grounding', () => {
  const tree = trace();
  const call = startCallTrace(under(tree), {
    req: request(),
    usage: startCallUsage('s', { history: [], input: [] }),
    binding,
    transport: 'interactions',
    step: 0,
    attempt: 0,
  });
  call.observe({
    type: 'evidence',
    evidence: { provider: 'google', kind: 'code_execution_call', id: 'x1', raw: { code: '1+1' } },
  });
  call.observe({
    type: 'evidence',
    evidence: { provider: 'google', kind: 'code_execution_result', callId: 'x1', raw: { r: 2 } },
  });
  call.observe({
    type: 'grounding',
    grounding: { sources: [{ type: 'web', title: 'a', uri: 'https://a.example' }] },
  });
  call.end({ stop: { kind: 'completed' } });
  const span = spanNamed(tree.collect(), 'generate_content gemini-test-flash');
  const [message] = attrs(span)['gen_ai.output.messages'] as [{ parts: TraceAttributes[] }];
  assertEquals(
    message.parts.map((p) => [p.type, p.id]),
    [
      ['server_tool_call', 'x1'],
      ['server_tool_call_response', 'x1'],
    ],
  );
  assertEquals(typeof message.parts[0]?.['theorem.observed_end'], 'string');
  assertEquals(
    span.events.map((e) => e.name),
    ['theorem.grounding'],
  );
});

Deno.test('turn trace: usage names follow semconv where it has them, theorem elsewhere', () => {
  assertEquals(
    usageAttributes({
      input: 30,
      output: 5,
      total: 35,
      cached: 4,
      byModality: { input: { text: 10, video: 20 }, output: { audio: 5 } },
      estimated: ['input'],
    }),
    {
      'gen_ai.usage.input_tokens': 30,
      'gen_ai.usage.output_tokens': 5,
      'gen_ai.usage.cache_read.input_tokens': 4,
      'gen_ai.usage.text.input_tokens': 10,
      'theorem.usage.video.input_tokens': 20,
      'gen_ai.usage.audio.output_tokens': 5,
      'theorem.usage.estimated': ['input'],
    },
  );
});
