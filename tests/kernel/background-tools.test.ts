import { createTestKernelScope } from '../fixtures/provider-scope.ts';
import { runScopedTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { z } from 'zod';
import {
  createMemoryToolExecution,
  type ToolBackground,
  type ToolBackgroundHandle,
  type ToolBackgroundService,
  type ToolExecutionCoordinator,
  type ToolOperationIdentity,
} from '../../mod.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import { appendAssistantEventsToHistory } from '../../src/interface/history.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { KernelScope } from '../../src/kernel/scope.ts';
import type { StageHandler } from '../../src/kernel/stages.ts';
import { ToolFailed } from '../../src/kernel/tools/failed.ts';
import type { FunctionToolDef, ToolContext } from '../../src/kernel/tools/types.ts';
import type { ModelRequest, TurnEvent, TurnModel, TurnRequest } from '../../src/kernel/types.ts';
import { memorySink } from '../../src/observability/trace.ts';
import type { TraceRecord } from '../../src/observability/trace-schema.ts';
import { geminiModels } from '../fixtures/models.ts';

const PROFILE = 'background_caller';
const TOOL = 'slow_job';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A body the test releases by hand, and the signal it was given. */
function heldBody() {
  const release = deferred<{ done: string }>();
  const started = deferred<AbortSignal | undefined>();
  const handler = (_input: unknown, ctx: ToolContext) => {
    started.resolve(ctx.signal);
    return release.promise;
  };
  return { release, started, handler };
}

function jobTool(over: Partial<FunctionToolDef>): FunctionToolDef {
  return {
    type: 'function',
    name: TOOL,
    description: 'A slow job.',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.strictObject({ topic: z.string().optional() }),
    output: z.object({ done: z.string() }),
    handler: () => ({ done: 'ok' }),
    ...over,
  } as FunctionToolDef;
}

function scopeWith(tool: Partial<FunctionToolDef>, extra: FunctionToolDef[] = []): KernelScope {
  const scope = createTestKernelScope();
  scope.tools.register(jobTool(tool));
  for (const more of extra) scope.tools.register(more);
  scope.profiles.register(
    defineProfile({
      type: 'text',
      id: PROFILE,
      identity: { handle: PROFILE, system: 'You help.' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 4,
      tools: { allow: [TOOL, ...extra.map((t) => t.name)] },
      inputs: { text: true },
    }),
  );
  return scope;
}

/** A model that makes these calls in its first step, then answers. */
function caller(
  calls: { name: string; callId: string; arguments: Record<string, unknown> }[],
  seen: ModelRequest[] = [],
): TurnModel {
  let step = 0;
  return {
    async *complete(req) {
      await Promise.resolve();
      seen.push(req);
      step += 1;
      if (step === 1) {
        for (const tool of calls) yield { type: 'tool', tool };
        return;
      }
      yield { type: 'text', text: 'Looking into it.' };
    },
  };
}

const callJob = (args: Record<string, unknown> = {}) => [
  { name: TOOL, callId: 'call_1', arguments: args },
];

function recording() {
  const handles: ToolBackgroundHandle[] = [];
  const sink: TurnEvent[] = [];
  const service: ToolBackgroundService = {
    detached: (handle) => handles.push(handle),
    event: (event) => {
      sink.push(event);
    },
  };
  return { service, handles, sink };
}

function lateCrashes(events: TurnEvent[]) {
  return events.flatMap((e) =>
    e.type === 'hook_failed' ? [[e.hook, e.callId, e.errorInternal]] : [],
  );
}

function phases(events: TurnEvent[]) {
  return events.flatMap((e) => (e.type === 'tool' && e.tool.phase ? [e.tool.phase] : []));
}

function identity(handle: ToolBackgroundHandle): ToolOperationIdentity {
  return { ...handle, profileId: PROFILE, invocationHash: '' };
}

function turn(
  scope: KernelScope,
  model: TurnModel,
  request: Partial<TurnRequest>,
  records?: TraceRecord[],
) {
  return Array.fromAsync(
    runScopedTurn(
      scope,
      { profile: PROFILE, input: { text: 'Go' }, ...request } as TurnRequest,
      model,
      records ? memorySink(records) : undefined,
    ),
  );
}

/** A turn whose call detached; its body waits for `release`. */
async function detached(
  setting: ToolBackground,
  over: { args?: Record<string, unknown>; onStage?: StageHandler } = {},
) {
  const body = heldBody();
  const scope = scopeWith({ background: setting, handler: body.handler });
  const execution = createMemoryToolExecution();
  const host = recording();
  const seen: ModelRequest[] = [];
  const events = await turn(scope, caller(callJob(over.args), seen), {
    execution,
    background: host.service,
    ...(over.onStage ? { onStage: over.onStage } : {}),
  });
  const handle = host.handles[0];
  assert(handle, `not detached: ${phases(events).join(',')}`);
  return { ...body, ...host, handle, scope, execution, events, seen };
}

async function failureCode(execution: ToolExecutionCoordinator, handle: ToolBackgroundHandle) {
  const known = await execution.lookup(identity(handle));
  assert(known?.kind === 'settled', `not settled: ${known?.kind}`);
  return known.outcome.replay.failure?.code;
}

Deno.test('an always tool answers at the hand-off and settles after the turn', async () => {
  const run = await detached('always');
  assert(phases(run.events).includes('background'));
  assert(!phases(run.events).includes('complete'));
  assert(run.events.some((e) => e.type === 'done'));
  assert(JSON.stringify(run.seen[1]?.history).includes('still running'));
  assertEquals((await run.execution.lookup(identity(run.handle)))?.kind, 'background');

  run.release.resolve({ done: 'late' });
  await run.handle.done;
  const known = await run.execution.lookup(identity(run.handle));
  assert(known?.kind === 'settled');
  assertEquals(known.outcome.effects, 'completed');
  assertEquals(phases(run.sink).at(-1), 'complete');
});

Deno.test('a backgrounded call joins the history as its reply, so the next turn can run', async () => {
  const run = await detached('always');
  const history = appendAssistantEventsToHistory([{ role: 'user', content: 'Go' }], run.events);
  const tool = history.find((message) => message.role === 'tool');
  assert(String(tool?.content).includes('still running'));
  const events = await turn(run.scope, caller([]), {
    input: { text: 'Any news?', history },
  });
  assert(events.some((event) => event.type === 'done'));
  run.release.resolve({ done: 'late' });
  await run.handle.done;
});

Deno.test('afterMs moves a running body past its reply', async () => {
  const run = await detached({ afterMs: 5 });
  assert(phases(run.events).includes('background'));
  run.release.resolve({ done: 'late' });
  await run.handle.done;
  assertEquals((await run.execution.lookup(identity(run.handle)))?.kind, 'settled');
});

Deno.test('a body that ends before afterMs answers with its real result', async () => {
  const scope = scopeWith({ background: { afterMs: 60_000 } });
  const host = recording();
  const events = await turn(scope, caller(callJob()), {
    execution: createMemoryToolExecution(),
    background: host.service,
  });
  assert(phases(events).includes('complete'));
  assert(!phases(events).includes('background'));
  assertEquals(host.handles, []);
});

Deno.test('ask detaches only when the model sets background, and the body never reads it', async () => {
  const body = heldBody();
  let input: unknown;
  const scope = scopeWith({
    background: 'ask',
    handler: (given, ctx) => {
      input = given;
      return body.handler(given, ctx);
    },
  });
  const execution = createMemoryToolExecution();
  const host = recording();
  const events = await turn(scope, caller(callJob({ topic: 'x', background: true })), {
    execution,
    background: host.service,
  });
  assert(phases(events).includes('background'));
  await body.started.promise;
  assertEquals(input, { topic: 'x' });
  body.release.resolve({ done: 'late' });
  await host.handles[0]?.done;

  const plain = await turn(scopeWith({ background: 'ask' }), caller(callJob({ topic: 'x' })), {
    execution: createMemoryToolExecution(),
    background: recording().service,
  });
  assert(phases(plain).includes('complete'));
  assert(!phases(plain).includes('background'));
});

Deno.test('the background argument reaches the wire only with a service', async () => {
  const wire = async (withService: boolean) => {
    const seen: ModelRequest[] = [];
    await turn(scopeWith({ background: 'ask' }), caller([], seen), {
      ...(withService
        ? { execution: createMemoryToolExecution(), background: recording().service }
        : {}),
    });
    return JSON.stringify(seen[0]?.wireTools);
  };
  assert((await wire(true)).includes('"background"'));
  assert(!(await wire(false)).includes('"background"'));
});

Deno.test('with no service every setting runs inline', async () => {
  for (const background of ['always', { afterMs: 0 }, 'ask'] as ToolBackground[]) {
    const events = await turn(scopeWith({ background }), caller(callJob()), {});
    assert(phases(events).includes('complete'));
    assert(!phases(events).includes('background'));
  }
});

Deno.test('a service with no detach on the coordinator reads as config', async () => {
  const { detach: _detach, ...plain } = createMemoryToolExecution();
  await assertRejects(
    () =>
      turn(scopeWith({ background: 'always' }), caller(callJob()), {
        execution: plain,
        background: recording().service,
      }),
    TheoremError,
    'detach',
  );
  await assertRejects(
    () =>
      turn(scopeWith({ background: 'always' }), caller(callJob()), {
        background: recording().service,
      }),
    TheoremError,
    'detach',
  );
});

Deno.test('tools that cannot detach read as config', () => {
  const kind = (fn: () => void) => {
    const error = assertThrows(fn, TheoremError);
    assertEquals(error.kind, 'config');
  };
  kind(() => scopeWith({ background: 'always', answeredBy: 'page', handler: undefined }));
  kind(() =>
    scopeWith({
      background: 'ask',
      input: z.object({ background: z.boolean() }),
    }),
  );
  kind(() => scopeWith({ background: { afterMs: -1 } }));
});

Deno.test('a T2 loader cannot detach', async () => {
  const scope = createTestKernelScope();
  scope.tools.register(jobTool({ background: 'always' }));
  scope.profiles.register(
    defineProfile({
      type: 'text',
      id: PROFILE,
      identity: { handle: PROFILE, system: 'You help.' },
      ...geminiModels('gemini35FlashLite'),
      tools: { allow: [TOOL], t2Loader: TOOL },
      inputs: { text: true },
    }),
  );
  await assertRejects(() => turn(scope, caller([]), {}), TheoremError, 'loader');
});

Deno.test('a sibling that fails after the reply does not reach the detached call', async () => {
  const body = heldBody();
  const scope = scopeWith({ background: 'always', handler: body.handler }, [
    jobTool({
      name: 'next_step',
      after: true,
      handler: () => {
        throw new Error('broken');
      },
    }),
  ]);
  const host = recording();
  await turn(
    scope,
    caller([
      { name: TOOL, callId: 'a', arguments: {} },
      { name: 'next_step', callId: 'b', arguments: { after: [TOOL] } },
    ]),
    { execution: createMemoryToolExecution(), background: host.service },
  );
  const signal = await body.started.promise;
  assertEquals(signal?.aborted, false);
  body.release.resolve({ done: 'late' });
  await host.handles[0]?.done;
  assertEquals(phases(host.sink).at(-1), 'complete');
});

Deno.test('a failed reply save stops the body, fails the call and marks the write failure', async () => {
  const body = heldBody();
  const scope = scopeWith({ background: 'always', handler: body.handler });
  const memory = createMemoryToolExecution();
  const marks: string[] = [];
  const execution: ToolExecutionCoordinator = {
    ...memory,
    detach: () => Promise.reject(new Error('store down')),
    markUncertain: (claim, reason) => {
      marks.push(reason);
      return memory.markUncertain(claim, reason);
    },
  };
  const host = recording();
  const turnRun = turn(scope, caller(callJob()), { execution, background: host.service });
  const signal = await body.started.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(signal?.aborted, true);
  body.release.resolve({ done: 'never read' });
  const events = await turnRun;
  const failed = events.find((event) => event.type === 'tool' && event.tool.phase === 'error');
  assert(failed?.type === 'tool' && failed.tool.phase === 'error');
  assertEquals(
    [failed.tool.failure.code, failed.tool.failure.message],
    [
      'hook_failed',
      'This action has an unresolved execution. Check the destination before trying it again.',
    ],
  );
  assertEquals(
    events.flatMap((event) =>
      event.type === 'hook_failed' ? [[event.hook, event.errorInternal]] : [],
    ),
    [['execution', 'store down']],
  );
  const done = events.find((event) => event.type === 'done');
  assertEquals(done?.type === 'done' && done.stop?.kind, 'completed');
  assertEquals(marks, ['settlement_write_failed']);
  assertEquals(host.handles, []);
});

Deno.test('a stop with a reason settles as cancelled, whatever the body does', async () => {
  const run = await detached('always');
  const signal = await run.started.promise;
  run.handle.stop('timed_out');
  assertEquals(signal?.aborted, true);
  run.release.resolve({ done: 'late' });
  await run.handle.done;
  const known = await run.execution.lookup(identity(run.handle));
  assert(known?.kind === 'settled');
  assertEquals(known.outcome.effects, 'unknown');
  assertEquals(known.outcome.replay.failure?.code, 'timed_out');
  assertEquals(known.outcome.replay.failure?.kind, 'cancelled');
  assertEquals(phases(run.sink).at(-1), 'error');
});

Deno.test('a stop with no reason ends the call as interrupted', async () => {
  const run = await detached('always');
  run.handle.stop();
  run.release.resolve({ done: 'late' });
  await run.handle.done;
  const known = await run.execution.lookup(identity(run.handle));
  assertEquals(known?.kind, 'uncertain');
});

Deno.test('graceMs cuts a body that ignores its signal and drops what comes later', async () => {
  const run = await detached('always');
  await run.started.promise;
  run.handle.stop('stopped', { graceMs: 1 });
  await run.handle.done;
  assertEquals(await failureCode(run.execution, run.handle), 'stopped');
  const seen = run.sink.length;
  run.release.resolve({ done: 'late' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals(run.sink.length, seen);
  assertEquals(await failureCode(run.execution, run.handle), 'stopped');
});

Deno.test('a shutdown with graceMs cuts the body, marks the claim and drops what comes later', async () => {
  const run = await detached('always');
  await run.started.promise;
  run.handle.stop(undefined, { graceMs: 1 });
  await run.handle.done;
  assertEquals((await run.execution.lookup(identity(run.handle)))?.kind, 'uncertain');
  const seen = run.sink.length;
  run.release.resolve({ done: 'late' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals(run.sink.length, seen);
  assertEquals((await run.execution.lookup(identity(run.handle)))?.kind, 'uncertain');
});

Deno.test('a service that throws on detached stops the body, and the model reads no reply', async () => {
  const body = heldBody();
  const scope = scopeWith({ background: 'always', handler: body.handler });
  const memory = createMemoryToolExecution();
  const marks: string[] = [];
  const execution: ToolExecutionCoordinator = {
    ...memory,
    markUncertain: (claim, reason) => {
      marks.push(reason);
      return memory.markUncertain(claim, reason);
    },
  };
  const service: ToolBackgroundService = {
    detached: () => {
      throw new Error('host broke');
    },
    event: () => {},
  };
  const events: TurnEvent[] = [];
  const running = turn(scope, caller(callJob()), { execution, background: service }).then(
    (seen) => events.push(...seen),
    () => {},
  );
  const signal = await body.started.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(signal?.aborted, true);
  body.release.resolve({ done: 'never read' });
  await running;
  assertEquals(marks, ['settlement_write_failed']);
  assert(!phases(events).includes('background'));
});

Deno.test('a stop after settlement does nothing', async () => {
  const run = await detached('always');
  run.release.resolve({ done: 'late' });
  await run.handle.done;
  run.handle.stop('stopped');
  assertEquals(await failureCode(run.execution, run.handle), undefined);
});

Deno.test('post_tool runs at the real end and its inject and abort are gone', async () => {
  const stages: string[] = [];
  const run = await detached('always', {
    onStage: (ctx) => {
      if (ctx.stage !== 'post_tool') return undefined;
      stages.push(ctx.stage);
      return { abort: { reason: 'enough' }, inject: [{ role: 'user', content: 'too late' }] };
    },
  });
  assertEquals(stages, []);
  run.release.resolve({ done: 'late' });
  await run.handle.done;
  assertEquals(stages, ['post_tool']);
  const known = await run.execution.lookup(identity(run.handle));
  assert(known?.kind === 'settled');
  assertEquals(known.outcome.replay.aborted, undefined);
  assertEquals(known.outcome.replay.pendingInject, undefined);
});

Deno.test('a detached call keeps the details post_tool put on its failure, on its event and its trace', async () => {
  const release = deferred<void>();
  const failure = { code: 'name_taken', kind: 'conflict', message: 'Ivy is taken.' } as const;
  const scope = scopeWith({
    background: 'always',
    handler: async () => {
      await release.promise;
      throw new ToolFailed(failure);
    },
  });
  const execution = createMemoryToolExecution();
  const host = recording();
  const records: TraceRecord[] = [];
  await turn(
    scope,
    caller(callJob()),
    {
      execution,
      background: host.service,
      onStage: (ctx) =>
        ctx.stage === 'post_tool' && ctx.failure
          ? { mutate: { details: { recordId: 'rec-1' } } }
          : undefined,
    },
    records,
  );
  const handle = host.handles[0];
  assert(handle);
  release.resolve();
  await handle.done;
  const known = await execution.lookup(identity(handle));
  assert(known?.kind === 'settled');
  assertEquals(known.outcome.replay.failure, { ...failure, details: { recordId: 'rec-1' } });
  const error = host.sink.find((e) => e.type === 'tool' && e.tool.phase === 'error');
  assert(error?.type === 'tool' && error.tool.phase === 'error');
  assertEquals(error.tool.failure.details, { recordId: 'rec-1' });
  assert(JSON.stringify(records.at(-1)).includes('rec-1'), 'the call trace carries the details');
});

Deno.test('a body that returns awaiting after the reply settles as a failure', async () => {
  const release = deferred<unknown>();
  const scope = scopeWith({
    background: 'always',
    output: z.looseObject({}),
    handler: () => release.promise,
  } as Partial<FunctionToolDef>);
  const execution = createMemoryToolExecution();
  const host = recording();
  await turn(scope, caller(callJob()), { execution, background: host.service });
  const handle = host.handles[0];
  assert(handle);
  release.resolve({ status: 'awaiting_user_input', kind: 'text', prompt: 'Your name?' });
  await handle.done;
  assertEquals(await failureCode(execution, handle), 'awaiting_after_reply');
});

Deno.test('a second run reads the reply, then the settled result, and starts no second body', async () => {
  let bodies = 0;
  const body = heldBody();
  const scope = scopeWith({
    background: 'always',
    handler: (input, ctx) => {
      bodies += 1;
      return body.handler(input, ctx);
    },
  });
  const execution = createMemoryToolExecution();
  const host = recording();
  const request = {
    profile: PROFILE,
    name: TOOL,
    input: {},
    callId: 'call_1',
    operationId: 'op-1',
    execution,
    background: host.service,
  };
  const first = await Array.fromAsync(scope.invokeTool(request));
  assert(phases(first).includes('background'));
  const again = await Array.fromAsync(scope.invokeTool(request));
  assert(phases(again).includes('background'));
  assertEquals(host.handles.length, 1);
  body.release.resolve({ done: 'late' });
  await host.handles[0]?.done;
  const settled = await Array.fromAsync(scope.invokeTool(request));
  assert(phases(settled).includes('complete'));
  assertEquals(bodies, 1);
});

Deno.test('invokeToolStep hands the reply to the step and leaves the body running', async () => {
  const body = heldBody();
  const scope = scopeWith({ background: 'always', handler: body.handler });
  const host = recording();
  const events = await Array.fromAsync(
    scope.invokeToolStep({
      profile: PROFILE,
      calls: [{ name: TOOL, callId: 'c1', input: {} }],
      execution: createMemoryToolExecution(),
      background: host.service,
    }),
  );
  assert(phases(events).includes('background'));
  body.release.resolve({ done: 'late' });
  await host.handles[0]?.done;
  assertEquals(phases(host.sink).at(-1), 'complete');
});

Deno.test('a gated always tool detaches when the host resumes it', async () => {
  const body = heldBody();
  const scope = scopeWith({
    background: 'always',
    permission: 'always_confirm',
    handler: body.handler,
  });
  const execution = createMemoryToolExecution();
  const host = recording();
  const request = {
    profile: PROFILE,
    name: TOOL,
    input: {},
    callId: 'call_1',
    operationId: 'op-1',
    execution,
    background: host.service,
  };
  const gated = await Array.fromAsync(scope.invokeTool(request));
  assert(phases(gated).includes('gate'));
  assertEquals(host.handles, []);
  const resumed = await Array.fromAsync(
    scope.invokeTool({ ...request, resume: { granted: true } }),
  );
  assert(phases(resumed).includes('background'));
  body.release.resolve({ done: 'late' });
  await host.handles[0]?.done;
});

Deno.test('a call that runs after this one starts at the reply', async () => {
  const body = heldBody();
  const order: string[] = [];
  const scope = scopeWith({ background: 'always', handler: body.handler }, [
    jobTool({
      name: 'next_step',
      after: true,
      handler: () => {
        order.push('next');
        return { done: 'ok' };
      },
    }),
  ]);
  const host = recording();
  const events = await turn(
    scope,
    caller([
      { name: TOOL, callId: 'a', arguments: {} },
      { name: 'next_step', callId: 'b', arguments: { after: ['slow_job'] } },
    ]),
    { execution: createMemoryToolExecution(), background: host.service },
  );
  assertEquals(order, ['next']);
  assert(phases(events).includes('complete'));
  body.release.resolve({ done: 'late' });
  await host.handles[0]?.done;
});

Deno.test('the turn signal reaches the call until the reply, and not after', async () => {
  const controller = new AbortController();
  const body = heldBody();
  const scope = scopeWith({ background: 'always', handler: body.handler });
  const host = recording();
  await turn(scope, caller(callJob()), {
    execution: createMemoryToolExecution(),
    background: host.service,
    signal: controller.signal,
  });
  const signal = await body.started.promise;
  controller.abort();
  assertEquals(signal?.aborted, false);
  body.release.resolve({ done: 'late' });
  await host.handles[0]?.done;
  assertEquals(phases(host.sink).at(-1), 'complete');
});

Deno.test('a detached call writes its own trace at its real end, joined to the turn', async () => {
  const records: TraceRecord[] = [];
  const body = heldBody();
  const scope = scopeWith({ background: 'always', handler: body.handler });
  const host = recording();
  const events = await turn(
    scope,
    caller(callJob()),
    { execution: createMemoryToolExecution(), background: host.service },
    records,
  );
  const before = records.length;
  body.release.resolve({ done: 'late' });
  await host.handles[0]?.done;
  assertEquals(records.length, before + 1);
  const done = events.find((e) => e.type === 'done');
  assert(done?.type === 'done');
  const traceId = done.traceparent?.split('-')[1];
  assert(JSON.stringify(records.at(-1)).includes(String(traceId)));
});

Deno.test('a detachable call that ends in its turn still writes its record', async () => {
  const records: TraceRecord[] = [];
  const scope = scopeWith({ background: { afterMs: 60_000 } });
  await turn(
    scope,
    caller(callJob()),
    { execution: createMemoryToolExecution(), background: recording().service },
    records,
  );
  assert(records.length >= 2, `records: ${records.length}`);
});

Deno.test('maxOutcomeBytes covers the late outcome', async () => {
  const body = heldBody();
  const scope = scopeWith({ background: 'always', handler: body.handler });
  const execution = { ...createMemoryToolExecution(), maxOutcomeBytes: 400 };
  const host = recording();
  await turn(scope, caller(callJob()), { execution, background: host.service });
  body.release.resolve({ done: 'x'.repeat(1000) });
  const handle = host.handles[0];
  assert(handle);
  await handle.done;
  assertEquals(await failureCode(execution, handle), 'result_too_large');
});

Deno.test('a service whose event throws still settles the call, and the crash goes on its trace', async () => {
  const records: TraceRecord[] = [];
  const body = heldBody();
  const scope = scopeWith({ background: 'always', handler: body.handler });
  const execution = createMemoryToolExecution();
  const handles: ToolBackgroundHandle[] = [];
  const service: ToolBackgroundService = {
    detached: (handle) => handles.push(handle),
    event: () => {
      throw new Error('event sink down');
    },
  };
  await turn(scope, caller(callJob()), { execution, background: service }, records);
  const handle = handles[0];
  assert(handle);
  body.release.resolve({ done: 'late' });
  await handle.done;
  assertEquals(await failureCode(execution, handle), undefined);
  const trace = JSON.stringify(records.at(-1));
  assert(trace.includes('theorem.hook_failed'));
  assert(trace.includes('event sink down'));
});

Deno.test('a late settle that fails keeps the call uncertain, and the host and the trace get the crash', async () => {
  const records: TraceRecord[] = [];
  const body = heldBody();
  const scope = scopeWith({ background: 'always', handler: body.handler });
  const memory = createMemoryToolExecution();
  const marks: string[] = [];
  const execution: ToolExecutionCoordinator = {
    ...memory,
    settle: () => {
      throw new Error('late store down');
    },
    markUncertain: (claim, reason) => {
      marks.push(reason);
      return memory.markUncertain(claim, reason);
    },
  };
  const host = recording();
  await turn(scope, caller(callJob()), { execution, background: host.service }, records);
  const handle = host.handles[0];
  assert(handle);
  body.release.resolve({ done: 'late' });
  await handle.done;
  assertEquals(marks, ['settlement_write_failed']);
  const trace = JSON.stringify(records.at(-1));
  assert(trace.includes('theorem.hook_failed'));
  assert(trace.includes('late store down'));
  assertEquals(lateCrashes(host.sink), [['execution', handle.callId, 'late store down']]);
});

Deno.test('a mark that fails after the turn reaches the host as its own report', async () => {
  const body = heldBody();
  const scope = scopeWith({ background: 'always', handler: body.handler });
  const execution: ToolExecutionCoordinator = {
    ...createMemoryToolExecution(),
    settle: () => {
      throw new Error('late store down');
    },
    markUncertain: () => {
      throw new Error('mark down');
    },
  };
  const host = recording();
  await turn(scope, caller(callJob()), { execution, background: host.service });
  const handle = host.handles[0];
  assert(handle);
  body.release.resolve({ done: 'late' });
  await handle.done;
  assertEquals(lateCrashes(host.sink), [
    ['execution', handle.callId, 'late store down'],
    ['execution', handle.callId, 'mark down'],
  ]);
});
