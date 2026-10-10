import { assert, assertEquals } from '@std/assert';
import {
  isCallTrace,
  traceGuardrails,
  traceOutcome,
  traceStory,
  traceTurnRow,
  traceTurns,
} from '../../react/src/client/trace-story.ts';
import { type TraceNode, traceTree } from '../../react/src/client/trace-view.ts';
import type { TraceSpan } from '../../src/observability/trace-span.ts';
import { stubRecord, stubSpan } from '../fixtures/trace-record.ts';

const MS = 1_000_000;

function span(
  id: string,
  parent: string | undefined,
  startMs: number,
  endMs: number,
  attributes: TraceSpan['attributes'],
  extra: Partial<TraceSpan> = {},
): TraceSpan {
  return {
    ...stubSpan(),
    spanId: id,
    ...(parent ? { parentSpanId: parent } : {}),
    startTimeUnixNano: String(startMs * MS),
    endTimeUnixNano: String(endMs * MS),
    attributes,
    ...extra,
  };
}

function rootOf(spans: TraceSpan[], content: Record<string, string> = {}): TraceNode {
  const [root] = traceTree([{ ...stubRecord(), spans, content }]);
  assert(root);
  return root;
}

const say = (role: string, hash: string) => [
  { role, parts: [{ type: 'text', content_sha256: hash }] },
];
const guardrail = (atMs: number, action: string) => ({
  name: 'theorem.guardrail',
  timeUnixNano: String(atMs * MS),
  attributes: { stage: 'input', trust: 'untrusted', action, hits: [] },
});

Deno.test('traceStory tells a turn in order: the ask, each call with its tools set in, what acted, and the answer', () => {
  const root = rootOf(
    [
      span(
        'root',
        undefined,
        0,
        1000,
        {
          'gen_ai.operation.name': 'invoke_agent',
          'gen_ai.agent.name': 'chat',
          'gen_ai.input.messages': say('user', 'q'),
          'gen_ai.output.messages': say('assistant', 'a'),
        },
        { events: [guardrail(0, 'allow'), guardrail(0, 'flag'), guardrail(900, 'redact')] },
      ),
      span('c1', 'root', 10, 300, {
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'm',
        'theorem.step': 1,
      }),
      span('h1', 'c1', 20, 290, { 'http.request.method': 'POST', 'url.path': '/v1' }),
      span('t1', 'root', 310, 400, {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': 'weather',
        'theorem.step': 1,
      }),
      span('t2', 'root', 320, 420, {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': 'sun',
        'theorem.step': 1,
      }),
      span('c2', 'root', 450, 950, {
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'm',
        'theorem.step': 2,
        'gen_ai.output.messages': say('assistant', 'a'),
      }),
    ],
    { q: 'Weather?', a: 'Sunny.' },
  );
  const story = traceStory(root);
  assertEquals(
    story.map((step) => (step.kind === 'span' ? step.node.span.spanId : step.kind)),
    ['ask', 'event', 'c1', 't1', 't2', 'c2', 'event', 'answer'],
  );
  const [ask] = story;
  assertEquals(ask?.kind === 'ask' && ask.text, 'Weather?');
  const spans = story.filter((step) => step.kind === 'span');
  // The first call only asked for tools; the second wrote the answer.
  assertEquals(
    spans.map((step) => [step.nested, step.requested]),
    [
      [false, 2],
      [true, 0],
      [true, 0],
      [false, 0],
    ],
  );
  const answer = story.at(-1);
  assertEquals(answer?.kind === 'answer' && answer.text, 'Sunny.');
});

Deno.test('traceOutcome names a tool that did not settle ok, and any failure', () => {
  const tool = (outcome: string, status: TraceSpan['status']['code'] = 'OK') =>
    rootOf([
      span(
        't',
        undefined,
        0,
        1,
        {
          'gen_ai.operation.name': 'execute_tool',
          'theorem.tool.outcome': outcome,
          'theorem.tool.failure.code': 'E1',
        },
        { status: { code: status } },
      ),
    ]);
  assertEquals(traceOutcome(tool('ok')), undefined);
  assertEquals(traceOutcome(tool('denied'))?.tone, 'warning');
  assertEquals(traceOutcome(tool('denied'))?.code, 'E1');
  assertEquals(traceOutcome(tool('error'))?.tone, 'error');

  const failed = (attributes: TraceSpan['attributes'], message?: string) =>
    traceOutcome(
      rootOf([
        span('s', undefined, 0, 1, attributes, {
          status: { code: 'ERROR', ...(message ? { message } : {}) },
        }),
      ]),
    );
  assertEquals(failed({ 'error.type': 'rate_limit' })?.label, 'Rate limit');
  assertEquals(failed({ 'error.type': 'TypeError' })?.label, 'TypeError');
  assertEquals(failed({}, 'boom')?.label, 'boom');
});

Deno.test("traceTurns splits a turn's time into model, tools, guardrails, hooks and the rest", () => {
  const root = rootOf([
    span(
      'root',
      undefined,
      0,
      1000,
      { 'gen_ai.operation.name': 'invoke_agent' },
      {
        events: [
          {
            name: 'theorem.guardrail',
            timeUnixNano: '0',
            attributes: {
              stage: 'input',
              action: 'allow',
              check: 'input',
              duration_ms: 20,
              hits: [],
            },
          },
          { name: 'theorem.stage', timeUnixNano: '0', attributes: { hook_ms: 30 } },
        ],
      },
    ),
    span('c1', 'root', 100, 500, {
      'gen_ai.operation.name': 'chat',
      'theorem.guardrail.stream_ms': 40,
    }),
    span(
      't1',
      'c1',
      500,
      700,
      { 'gen_ai.operation.name': 'execute_tool' },
      {
        events: [
          {
            name: 'theorem.guardrail',
            timeUnixNano: '0',
            attributes: {
              stage: 'tool_result',
              action: 'allow',
              check: 'tool_result',
              duration_ms: 15,
              hits: [],
            },
          },
          { name: 'theorem.stage', timeUnixNano: '0', attributes: { hook_ms: 5 } },
        ],
      },
    ),
  ]);
  const [turn] = traceTurns([root]);
  // The tool's own checks and hooks are taken out of its time, not counted twice.
  assertEquals(turn?.split, { model: 360, tools: 180, guardrails: 75, hooks: 35, other: 350 });
});

Deno.test("a host call's time is its tool's, less the tool's own checks and hooks", () => {
  const root = rootOf([
    span(
      't1',
      undefined,
      0,
      400,
      { 'gen_ai.operation.name': 'execute_tool' },
      {
        events: [
          {
            name: 'theorem.guardrail',
            timeUnixNano: '0',
            attributes: {
              stage: 'tool_result',
              action: 'allow',
              check: 'tool_result',
              duration_ms: 15,
              hits: [],
            },
          },
          { name: 'theorem.stage', timeUnixNano: '0', attributes: { hook_ms: 5 } },
        ],
      },
    ),
  ]);
  const [turn] = traceTurns([root]);
  assertEquals(turn?.split, { model: 0, tools: 380, guardrails: 15, hooks: 5, other: 0 });
});

Deno.test("an agent tool's time holds its agent's model calls once, as the model's", () => {
  const root = rootOf([
    span('root', undefined, 0, 1000, { 'gen_ai.operation.name': 'invoke_agent' }),
    span('c1', 'root', 0, 200, { 'gen_ai.operation.name': 'chat' }),
    span('t1', 'c1', 200, 800, { 'gen_ai.operation.name': 'execute_tool' }),
    span('a1', 't1', 250, 750, { 'gen_ai.operation.name': 'invoke_agent' }),
    span('c2', 'a1', 300, 700, { 'gen_ai.operation.name': 'chat' }),
    span('c3', 'root', 800, 1000, { 'gen_ai.operation.name': 'chat' }),
  ]);
  const [turn] = traceTurns([root]);
  assertEquals(turn?.split, { model: 800, tools: 200, guardrails: 0, hooks: 0, other: 0 });
});

Deno.test("a host's trace reads as tool calls; a conversation's as turns", () => {
  const call = rootOf([span('c1', undefined, 0, 10, { 'gen_ai.operation.name': 'execute_tool' })]);
  const turn = rootOf([span('t1', undefined, 0, 10, { 'gen_ai.operation.name': 'invoke_agent' })]);
  assert(isCallTrace(traceTurns([call])));
  assert(!isCallTrace(traceTurns([call, turn])));
  assert(!isCallTrace([]));
});

Deno.test("a host call's row is named by its tool, and a failed one says how it ended", () => {
  const ok = rootOf([
    span('c1', undefined, 0, 10, {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'get_weather',
    }),
  ]);
  const [row] = traceTurns([ok]).map((turn) => traceTurnRow(turn, true));
  assertEquals(row?.actor, 'tool');
  assertEquals(row?.title, ok.meta.subject);
  const bad = rootOf([
    span(
      'c2',
      undefined,
      0,
      10,
      { 'gen_ai.operation.name': 'execute_tool', 'error.type': 'network' },
      { status: { code: 'ERROR' } },
    ),
  ]);
  const [failed] = traceTurns([bad]).map((turn) => traceTurnRow(turn, true));
  assertEquals(failed?.actor, 'error');
  assertEquals(failed?.outcome, traceOutcome(bad));
  assertEquals(failed?.answered, undefined);
});

Deno.test('traceGuardrails lists every check in order, with the rules that fired and why', () => {
  const root = rootOf([
    span(
      'root',
      undefined,
      0,
      1000,
      { 'gen_ai.operation.name': 'invoke_agent' },
      {
        events: [
          {
            name: 'theorem.guardrail',
            timeUnixNano: String(5 * MS),
            attributes: {
              stage: 'input',
              action: 'allow',
              check: 'input',
              duration_ms: 1,
              hits: [],
            },
          },
        ],
      },
    ),
    span(
      't1',
      'root',
      100,
      300,
      { 'gen_ai.operation.name': 'execute_tool' },
      {
        events: [
          {
            name: 'theorem.guardrail',
            timeUnixNano: String(290 * MS),
            attributes: {
              stage: 'tool_result',
              action: 'redact',
              check: 'tool_result',
              duration_ms: 0.4,
              hits: [
                {
                  rule: 'detect.tool_instructions',
                  severity: 'high',
                  match: 'ignore previous',
                },
              ],
              provenance: { tool: 'search_places' },
            },
          },
        ],
      },
    ),
  ]);
  const [pass, hit] = traceGuardrails(root);
  assertEquals(
    [pass?.stageLabel, pass?.actionLabel, pass?.durationMs],
    ['User input', 'Allowed', 1],
  );
  assertEquals(
    [hit?.checkLabel, hit?.actionLabel, hit?.durationMs, hit?.tool, hit?.node.span.spanId],
    ['Result check', 'Redacted', 0.4, 'search_places', 't1'],
  );
  assertEquals(hit?.hits, [
    {
      rule: 'detect.tool_instructions',
      ruleLabel: 'Tool instructions',
      ruleDoc:
        'A tool\'s text instructed the agent: it told it to set its instructions aside, such as "ignore your instructions", or beside an address it named a tool the model can call, gave an order such as "you must now…", or claimed to speak for the user, the system or an admin. Each match says which in its signal. The decision names the boundary it was crossing and what was done with it.',
      severity: 'high',
      severityLabel: 'High',
      match: 'ignore previous',
    },
  ]);
});
