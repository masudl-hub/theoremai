import '../fixtures/test-host.ts';
import { z } from 'zod';
import { lexiconText } from '../../src/guardrails/lexicon.ts';
import { registerTool } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { AWAITING_USER_INPUT_STATUS } from '../../src/kernel/schema.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import type { StageHandler } from '../../src/kernel/stages.ts';
import {
  coerceToolResultParts,
  executeFunction,
  executeRegisteredTool,
  leanToolResultData,
  projectForModel,
  type ToolExecuteSettlement,
  yieldHandlerSideEvent,
} from '../../src/kernel/tools/execute.ts';
import type { ToolStageSupport } from '../../src/kernel/tools/stage-run.ts';
import type {
  FunctionToolDef,
  ToolContext,
  ToolStreamEvent,
  TurnToolSnapshot,
} from '../../src/kernel/tools/types.ts';
import type { Profile, TurnEvent } from '../../src/kernel/types.ts';
import { startTrace } from '../../src/observability/trace-span.ts';
import { toolEventsOf } from '../fixtures/events.ts';

function check(actual: unknown, expected: unknown, label: string): void {
  assertEquals([label, actual], [label, expected]);
}

const base = { name: 'probe', callId: 'c1' };
const FindingOutput = z.object({ finding: z.string() });
const AWAITING = { status: AWAITING_USER_INPUT_STATUS, kind: 'text', prompt: 'Your name?' };
const AwaitingOutput = z.object({
  status: z.literal(AWAITING_USER_INPUT_STATUS),
  kind: z.literal('text'),
  prompt: z.string(),
});

function profileOf(tools: Record<string, unknown> = {}): Profile {
  return {
    id: 'exec-a',
    type: 'text',
    tools: { allow: ['probe'], ...tools },
  } as unknown as Profile;
}

function makeTool(overrides: Record<string, unknown> = {}): FunctionToolDef {
  return {
    type: 'function',
    name: 'probe',
    description: 'probe',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({ value: z.number() }),
    output: FindingOutput,
    inputSchema: {},
    outputSchema: {},
    handler: () => ({ finding: 'ok' }),
    ...overrides,
  } as unknown as FunctionToolDef;
}

async function drain<T>(gen: AsyncGenerator<TurnEvent, T>) {
  const events: TurnEvent[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { events, settlement: next.value };
    events.push(next.value);
  }
}

function stagesOf(
  handlers: StageHandler[],
  over: Partial<ToolStageSupport> = {},
): ToolStageSupport {
  return {
    handlers,
    profile: profileOf(),
    step: 1,
    history: () => [],
    injectAllowed: true,
    ...over,
  };
}

function afterTool(result: (ctx: Parameters<StageHandler>[0]) => ReturnType<StageHandler>) {
  return ((ctx) => (ctx.stage === 'post_tool' ? result(ctx) : undefined)) as StageHandler;
}

function run(
  tool: FunctionToolDef,
  opts: {
    stages?: ToolStageSupport;
    snapshot?: TurnToolSnapshot;
    profile?: Profile;
    ctx?: Partial<ToolContext>;
    input?: unknown;
  } = {},
) {
  const ctx = {
    profile: opts.profile ?? profileOf(),
    callId: base.callId,
    ...opts.ctx,
  } as ToolContext;
  return drain(
    executeFunction(
      defaultKernelScope.tools,
      tool,
      opts.input ?? { value: 1 },
      ctx,
      base,
      opts.snapshot,
      opts.stages,
    ),
  );
}

function snapshotOf(over: Partial<TurnToolSnapshot> = {}): TurnToolSnapshot {
  return {
    builtins: [],
    gated: [],
    visible: [],
    executable: [],
    wire: [],
    path: 'web',
    ...over,
  };
}

const registered = {
  category: 'test',
  access: 'read-only' as const,
  paths: ['*'],
  loadTier: 'T0' as const,
  permission: 'auto' as const,
};

Deno.test('every tool type is traced and framed with its own origin', async () => {
  registerTool({
    type: 'http',
    name: 'origin_http',
    description: 'http',
    endpoint: 'https://api.example.com/x',
    method: 'GET',
    ...registered,
    input: z.object({}),
    output: z.unknown(),
    preTool: () => ({ deny: { code: 'stop', message: 'no' } }),
  });
  registerTool({
    type: 'mcp',
    name: 'origin_mcp',
    description: 'mcp',
    serverUrl: 'https://mcp.example.com/sse',
    mcpToolName: 'x',
    ...registered,
    input: z.object({}),
    output: z.unknown(),
    preTool: () => ({ deny: { code: 'stop', message: 'no' } }),
  });
  registerTool({
    type: 'function',
    name: 'origin_function',
    description: 'function',
    ...registered,
    input: z.object({}),
    output: FindingOutput,
    handler: () => ({ finding: 'fine' }),
  });
  registerTool({
    type: 'builtin',
    name: 'origin_builtin',
    description: 'builtin',
    ...registered,
    wire: {},
  });
  const profile = profileOf({
    allow: ['origin_http', 'origin_mcp', 'origin_function', 'origin_builtin'],
  });
  const table: [string, string, boolean][] = [
    ['origin_http', 'http', true],
    ['origin_mcp', 'mcp', true],
    ['origin_function', 'local', true],
    ['origin_builtin', 'builtin', false],
  ];
  for (const [name, origin, guarded] of table) {
    const tree = startTrace('root', { kind: 'INTERNAL' });
    const { settlement } = await drain(
      executeRegisteredTool({
        tools: defaultKernelScope.tools,
        profile,
        name,
        input: {},
        callId: 'c1',
        ctx: {},
        snapshot: snapshotOf({
          builtins: ['origin_builtin'],
          gated: table.map(([n]) => n),
          visible: table.map(([n]) => n),
        }),
        openSpan: (_name, attributes) => {
          tree.root.set(attributes);
          return tree.root;
        },
      }),
    );
    const [root] = tree.collect();
    check(root?.attributes['theorem.tool.origin'], origin, `${name} span origin`);
    if (guarded) {
      check(settlement.modelResult?.provenance, { origin, tool: name, depth: 1 }, `${name} tag`);
    }
  }
});

Deno.test('coerceToolResultParts keeps well-formed parts and drops the rest', () => {
  const text = { type: 'text', text: 'one' };
  const image = { type: 'image', mimeType: 'image/png', data: 'abc' };
  const cases: [string, unknown, unknown][] = [
    ['not an array: number', 5, undefined],
    ['not an array: object', { length: 0 }, undefined],
    ['not an array: null', null, undefined],
    ['empty array', [], undefined],
    ['text and media kept in order', [text, image], [text, image]],
    ['null entry skipped', [null, text], [text]],
    ['primitive entry skipped', [5, 'x', text], [text]],
    ['entry without a type skipped', [{ text: 'x' }, text], [text]],
    ['non-string type skipped', [{ type: 5, text: 'x' }, text], [text]],
    ['text part with a non-string text skipped', [{ type: 'text', text: 5 }, text], [text]],
    ['unknown type with text skipped', [{ type: 'bogus', text: 'x' }, text], [text]],
    ['media with a text field is not text', [{ ...image, text: 'x' }], [image]],
    ['blank mime type skipped', [{ ...image, mimeType: '   ' }, image], [image]],
    ['missing mime type skipped', [{ type: 'image', data: 'abc' }, image], [image]],
    ['array data skipped', [{ ...image, data: ['abc'] }, image], [image]],
    ['non-string data skipped', [{ ...image, data: 5 }, image], [image]],
    ['empty data skipped', [{ ...image, data: '' }, image], [image]],
    ['nothing usable is undefined, not empty', [{ type: 'bogus' }, null], undefined],
    ['extra fields are not carried', [{ ...image, extra: 1 }], [image]],
  ];
  for (const [label, raw, expected] of cases) {
    check(coerceToolResultParts(raw), expected, label);
  }
  for (const type of ['audio', 'video', 'document']) {
    const part = { type, mimeType: 'x/y', data: 'd' };
    check(coerceToolResultParts([part]), [part], `${type} part kept`);
  }
});

Deno.test('leanToolResultData drops parts from records and returns anything else untouched', () => {
  const list = [1, 2];
  check(leanToolResultData({ a: 1, parts: [1] }), { a: 1 }, 'record');
  check(leanToolResultData('abc'), 'abc', 'string');
  check(leanToolResultData(5), 5, 'number');
  check(leanToolResultData(null), null, 'null');
  check(leanToolResultData(undefined), undefined, 'undefined');
  check(leanToolResultData(list), list, 'array');
});

Deno.test('a handler side event of an unknown kind is ignored', () => {
  const bogus = { kind: 'bogus' } as unknown as Exclude<ToolStreamEvent, { kind: 'complete' }>;
  check([...yieldHandlerSideEvent(base, bogus)], [], 'unknown kind yields nothing');
});

Deno.test('a stream handler stops at the first event after the call is aborted', async () => {
  const controller = new AbortController();
  const tool = makeTool({
    handler: async function* () {
      controller.abort();
      yield { kind: 'progress', data: 1 };
      yield { kind: 'complete', output: { finding: 'late' } };
    },
  });
  const { events, settlement } = await run(tool, { ctx: { signal: controller.signal } });
  check(toolEventsOf(events, 'progress'), [], 'no progress after abort');
  check(toolEventsOf(events, 'complete'), [], 'no completion after abort');
  check('outputRaw' in settlement, false, 'no output');
  check(settlement.failure?.code, 'handler_error', 'the abort fails the call');
});

Deno.test('projectForModel reports an awaiting output as a prompt and any other output as a result', () => {
  const visible = makeTool();
  check(
    projectForModel(visible, AWAITING),
    {
      finding: lexiconText('tool.awaiting_user', { kind: 'text', prompt: 'Your name?' }),
      data: AWAITING,
    },
    'awaiting',
  );
  check(
    projectForModel(visible, AWAITING).finding,
    'Awaiting user input (text): Your name?',
    'awaiting wording',
  );
  check(projectForModel(visible, null), { finding: 'null' }, 'null output');
  check(projectForModel(visible, 'plain'), { finding: 'plain' }, 'string output');
  check(
    projectForModel(visible, { status: AWAITING_USER_INPUT_STATUS, kind: 'text' }),
    { finding: '{"status":"awaiting_user_input","kind":"text"}' },
    'incomplete awaiting shape is an ordinary output',
  );
});

Deno.test('the T2 loader fails when the call has no turn snapshot', async () => {
  const loader = makeTool({
    name: 'loader',
    output: z.object({ loaded: z.array(z.string()) }),
    handler: () => ({ loaded: ['record_lookup'] }),
  });
  const profile = profileOf({ allow: ['loader', 'record_lookup'], t2Loader: 'loader' });
  const { events, settlement } = await run(loader, { profile });
  const failure = {
    code: 'invalid_output',
    kind: 'bad_response',
    message: "tools.t2Loader 'loader' requires a turn tool snapshot",
  };
  check(settlement.failure, failure, 'failure');
  check(
    settlement.failure?.message,
    lexiconText('tool.t2_loader_needs_snapshot', { tool: 'loader' }),
    'wording',
  );
  check(
    toolEventsOf(events, 'error').map((e) => e.failure),
    [failure],
    'error event',
  );
  check('outputRaw' in settlement, false, 'no output');
});

Deno.test('the T2 loader fails when its output is not a list of ids', async () => {
  const loader = makeTool({
    name: 'loader',
    output: z.object({ loaded: z.array(z.number()) }),
    handler: () => ({ loaded: [1] }),
  });
  const profile = profileOf({ allow: ['loader'], t2Loader: 'loader' });
  const { settlement } = await run(loader, {
    profile,
    snapshot: snapshotOf({ gated: ['record_lookup'] }),
  });
  check(
    settlement.failure,
    {
      code: 'invalid_output',
      kind: 'bad_response',
      message: "T2 loader 'loader' must return { loaded: string[] }",
    },
    'failure',
  );
  check(
    settlement.failure?.message,
    lexiconText('tool.t2_loader_shape', { tool: 'loader' }),
    'wording',
  );
});

Deno.test('the T2 loader output is checked again once promotion has rewritten it', async () => {
  const output = z.object({ loaded: z.array(z.string()).min(1) });
  const loader = makeTool({
    name: 'loader',
    output,
    handler: () => ({ loaded: ['record_lookup'] }),
  });
  const profile = profileOf({ allow: ['loader', 'record_lookup'], t2Loader: 'loader' });
  const snapshot = snapshotOf({ gated: ['loader'] });
  const { events, settlement } = await run(loader, { profile, snapshot });
  const parsed = output.safeParse({ loaded: [] });
  check(parsed.success, false, 'the rewritten output is invalid');
  check(
    settlement.failure,
    {
      code: 'invalid_output',
      kind: 'bad_response',
      message: 'T2 loader output validation failed after promotion',
      details: parsed.success ? undefined : parsed.error.flatten(),
    },
    'failure',
  );
  check('outputRaw' in settlement, false, 'no output');
  check(toolEventsOf(events, 'complete'), [], 'no completion');
  check(snapshot.visible, [], 'nothing promoted');
});

Deno.test('the T2 loader promotes the tools it names and reports exactly those', async () => {
  registerTool({
    type: 'function',
    name: 'exec_a_deferred',
    description: 'deferred',
    ...registered,
    loadTier: 'T2',
    input: z.object({}),
    output: FindingOutput,
    handler: () => ({ finding: 'x' }),
  });
  const loader = makeTool({
    name: 'loader',
    output: z.object({ loaded: z.array(z.string()) }),
    handler: () => ({ loaded: ['record_lookup', 'exec_a_deferred'] }),
  });
  const profile = profileOf({
    allow: ['loader', 'record_lookup', 'exec_a_deferred'],
    t2Loader: 'loader',
  });
  const snapshot = snapshotOf({ gated: ['record_lookup'] });
  const { settlement } = await run(loader, { profile, snapshot });
  check(settlement.failure, undefined, 'no failure');
  check(settlement.outputRaw, { loaded: ['record_lookup'] }, 'only the gated tool is promoted');
  check(snapshot.visible, ['record_lookup'], 'visible');
});

Deno.test('a result is completed with its activity label, parts and read-back', async () => {
  const tool = makeTool({
    input: z.object({ value: z.number() }),
    output: z.object({ finding: z.string(), parts: z.array(z.unknown()) }),
    labels: { activityPast: 'Looked up {input.value} and found {output.finding}' },
    handler: () => ({
      finding: 'palm',
      parts: [{ type: 'image', mimeType: 'image/jpeg', data: 'abc' }, { type: 'bogus' }],
    }),
  });
  const { events, settlement } = await run(tool, { input: { value: 7 } });
  const [complete] = toolEventsOf(events, 'complete');
  check(complete?.activityPast, 'Looked up 7 and found palm', 'activity label');
  check(complete?.parts, [{ type: 'image', mimeType: 'image/jpeg', data: 'abc' }], 'parts');
  check(complete?.readBack, 'palm', 'read-back');
  check(settlement.modelResult?.parts, complete?.parts, 'model result parts');

  const plain = await run(makeTool());
  const [bare] = toolEventsOf(plain.events, 'complete');
  check('parts' in (bare ?? {}), false, 'no parts key without parts');
  check('activityPast' in (bare ?? {}), false, 'no label key without a label');
});

Deno.test('an awaiting output settles as awaiting and an ordinary one does not', async () => {
  const seen: unknown[] = [];
  const stages = stagesOf([
    afterTool((ctx) => {
      seen.push(ctx.awaiting);
      return undefined;
    }),
  ]);
  const awaiting = await run(makeTool({ output: AwaitingOutput, handler: () => AWAITING }), {
    stages,
  });
  check(awaiting.settlement.awaiting, true, 'awaiting settlement');
  check(awaiting.settlement.outputRaw, AWAITING, 'awaiting output');
  const ordinary = await run(makeTool(), { stages });
  check('awaiting' in ordinary.settlement, false, 'ordinary settlement');
  const failed = await run(makeTool({ handler: () => undefined }), { stages });
  check('awaiting' in failed.settlement, false, 'failed settlement');
  check(seen, [true, undefined, undefined], 'what the post_tool stage is told');
  const unstaged = await run(makeTool());
  check('awaiting' in unstaged.settlement, false, 'ordinary settlement without stages');
});

Deno.test('a post_tool deny replaces the result with a blocked failure and clears awaiting', async () => {
  const stages = stagesOf([
    afterTool(() => ({ deny: { code: 'policy', message: 'not for this user' } })),
  ]);
  for (const [label, tool] of [
    ['ordinary', makeTool()],
    ['awaiting', makeTool({ output: AwaitingOutput, handler: () => AWAITING })],
  ] as const) {
    const { events, settlement } = await run(tool, { stages });
    check(
      settlement.failure,
      { code: 'policy', kind: 'blocked', message: 'not for this user' },
      `${label} failure`,
    );
    check(settlement.denied, true, `${label} denied`);
    check('awaiting' in settlement, false, `${label} awaiting`);
    check('outputRaw' in settlement, false, `${label} output`);
    check(toolEventsOf(events, 'complete'), [], `${label} completion`);
    check(toolEventsOf(events, 'error').length, 1, `${label} error event`);
  }
});

Deno.test('a post_tool mutate replaces the output without denying the call', async () => {
  const stages = stagesOf([afterTool(() => ({ mutate: { output: { finding: 'edited' } } }))]);
  const { events, settlement } = await run(makeTool(), { stages });
  check(settlement.outputRaw, { finding: 'edited' }, 'output');
  check('denied' in settlement, false, 'denied');
  check('failure' in settlement, false, 'failure');
  check(
    toolEventsOf(events, 'complete').map((e) => e.output),
    [{ finding: 'edited' }],
    'event',
  );

  const invalid = await run(makeTool(), {
    stages: stagesOf([afterTool(() => ({ mutate: { output: { finding: 3 } } }))]),
  });
  check(invalid.settlement.failure?.code, 'invalid_output', 'invalid mutate failure');
  check(invalid.settlement.awaiting, undefined, 'invalid mutate awaiting');
  check('denied' in invalid.settlement, false, 'invalid mutate is not a deny');
});

Deno.test('a pre_tool deny settles as denied, a post_tool stage that keeps the result does not', async () => {
  const denied = await run(
    makeTool({ preTool: () => ({ deny: { code: 'no', message: 'nope' } }) }),
  );
  check(denied.settlement.denied, true, 'pre_tool deny');
  check(denied.settlement.callNotStarted, true, 'call not started');
  const plain = await run(makeTool(), { stages: stagesOf([afterTool(() => undefined)]) });
  check('denied' in plain.settlement, false, 'untouched result');
  check('callNotStarted' in plain.settlement, false, 'started call');
});

Deno.test('a post_tool abort and inject are carried on the settlement', async () => {
  const unit = { messages: [{ role: 'user', content: 'also check the soil' }] };
  const { settlement } = await run(makeTool(), {
    stages: stagesOf([
      afterTool(() => ({
        abort: { reason: 'enough' },
        inject: [{ role: 'user', content: 'also check the soil' }],
      })),
    ]),
  });
  check(settlement.aborted, { reason: 'enough' }, 'aborted');
  check(settlement.pendingInject, [unit], 'pendingInject');
  check(settlement.outputRaw, { finding: 'ok' }, 'the result is kept');

  const bare = await run(makeTool(), { stages: stagesOf([afterTool(() => ({ abort: true }))]) });
  check(bare.settlement.aborted, true, 'abort true');
  check('pendingInject' in bare.settlement, false, 'no inject');

  const none = await run(makeTool(), { stages: stagesOf([afterTool(() => undefined)]) });
  check('aborted' in none.settlement, false, 'no abort');
  check('pendingInject' in none.settlement, false, 'no inject without one');
});

Deno.test('sources are cited before completion for a result and never for a failure', async () => {
  const cited: unknown[] = [];
  const source = { title: 'Porto', uri: 'https://example.com/porto', type: 'web' };
  const sources = (output: unknown) => {
    cited.push(output);
    return [source];
  };
  const ok = await run(makeTool({ sources }));
  check(cited, [{ finding: 'ok' }], 'sources saw the output');
  check(
    ok.events.flatMap((e) => (e.type === 'citation' ? [e.sources] : [])),
    [[source]],
    'citation',
  );
  const citedAt = ok.events.findIndex((e) => e.type === 'citation');
  const completeAt = ok.events.findIndex((e) => e.type === 'tool' && e.tool.phase === 'complete');
  check(citedAt >= 0 && citedAt < completeAt, true, 'cited before completion');

  cited.length = 0;
  const failed = await run(makeTool({ sources, handler: () => undefined }));
  check(cited, [], 'sources not asked for a failure');
  check(toolEventsOf(failed.events, 'warning'), [], 'no sources warning');
  check(
    failed.events.some((e) => e.type === 'citation'),
    false,
    'no citation',
  );
});

Deno.test('a settlement carries the model result, the guard-tagged text and ordered events', async () => {
  const { events, settlement } = await run(makeTool());
  const result: ToolExecuteSettlement = settlement;
  check(result.modelResult?.finding, 'ok', 'finding');
  check(result.modelResult?.provenance, { origin: 'local', tool: 'probe', depth: 1 }, 'provenance');
  check(
    events.filter((e) => e.type === 'tool').map((e) => (e.type === 'tool' ? e.tool.phase : '')),
    ['running', 'complete'],
    'phases',
  );
});
