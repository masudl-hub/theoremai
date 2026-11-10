import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { assert, assertEquals, assertRejects } from '@std/assert';
import { z } from 'zod';
import { createMemoryToolExecution, type ToolExecutionCoordinator } from '../../mod.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import { forClientEvents } from '../../src/host/mod.ts';
import { registerProfile, registerTool } from '../../src/kernel/default-scope.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { TurnStage } from '../../src/kernel/schema.ts';
import type { TurnEvent, TurnModel, TurnRequest } from '../../src/kernel/types.ts';
import { geminiModels, HOST_BINDINGS } from '../fixtures/models.ts';

const TOOL = 'hook_crash_tool';
const DID_NOT_RUN = 'This tool call did not run: the app hit an error before it could start.';
const PROFILE = 'hook_crash_caller';
let bodies = 0;

registerTool({
  type: 'function',
  name: TOOL,
  description: 'Reads a value.',
  category: 'test',
  access: 'read-write',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
  input: z.object({ val: z.number() }),
  output: z.object({ finding: z.string() }),
  handler: () => {
    bodies += 1;
    return { finding: 'ok' };
  },
});
registerProfile({
  type: 'text',
  id: PROFILE,
  identity: { handle: PROFILE },
  ...geminiModels('gemini35FlashLite'),
  maxSteps: 3,
  tools: { allow: [TOOL] },
  inputs: { text: true },
  outputs: {},
  guardrails: { quota: { perDay: 500 } },
});

/** A model that calls the tool once, then answers. */
function caller(): TurnModel {
  let step = 0;
  return {
    async *complete() {
      await Promise.resolve();
      step += 1;
      if (step === 1) {
        yield { type: 'tool', tool: { name: TOOL, arguments: { val: 1 }, callId: 'c1' } };
        return;
      }
      yield { type: 'text', text: 'Turn went on.' };
    },
  };
}

function turn(request: Partial<TurnRequest>, model: TurnModel = caller()): Promise<TurnEvent[]> {
  return Array.fromAsync(
    runTurn({ profile: PROFILE, input: { text: 'Go' }, ...request } as TurnRequest, model),
  );
}

function reports(events: TurnEvent[]) {
  return events.flatMap((e) => (e.type === 'hook_failed' ? [e] : []));
}

/** The call id of the call that failed. */
function failedCall(events: TurnEvent[]): string | undefined {
  const failed = events.find((e) => e.type === 'tool' && e.tool.phase === 'error');
  return failed?.type === 'tool' ? failed.tool.callId : undefined;
}

function toolFailures(events: TurnEvent[]) {
  return events.flatMap((e) =>
    e.type === 'tool' && e.tool.phase === 'error' && e.tool.failure
      ? [[e.tool.failure.code, e.tool.failure.message]]
      : [],
  );
}

/** The turn went on: the model answered, nothing ended it as an error, and it finished. */
function assertWentOn(events: TurnEvent[]): void {
  assertEquals(
    events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join(''),
    'Turn went on.',
  );
  assertEquals(
    events.filter((e) => e.type === 'error'),
    [],
  );
  const done = events.find((e) => e.type === 'done');
  assert(done?.type === 'done');
  assertEquals(done.stop?.kind, 'completed');
}

function crashOn(stage: TurnStage) {
  return (ctx: { stage: TurnStage }) => {
    if (ctx.stage === stage) throw new Error(`${stage} broke`);
    return undefined;
  };
}

for (const stage of ['pre_turn', 'post_tool', 'before_end', 'post_turn'] as const) {
  Deno.test(`an onStage throw at ${stage} is reported once, and the turn goes on`, async () => {
    const events = await turn({
      execution: createMemoryToolExecution(),
      onStage: crashOn(stage),
    });
    const seen = reports(events);
    assertEquals(seen.length, 1);
    assertEquals(seen[0]?.hook, 'onStage');
    assertEquals(seen[0]?.stage, stage);
    assertEquals(seen[0]?.errorInternal, `${stage} broke`);
    assertEquals(toolFailures(events), []);
    assertWentOn(events);
  });
}

Deno.test('an onStage throw at pre_tool fails the call, and the turn goes on', async () => {
  const before = bodies;
  const events = await turn({
    execution: createMemoryToolExecution(),
    onStage: crashOn('pre_tool'),
  });
  assertEquals(toolFailures(events), [['hook_failed', DID_NOT_RUN]]);
  assertEquals(
    reports(events).map((e) => [e.hook, e.stage, e.callId, e.errorInternal]),
    [['onStage', 'pre_tool', failedCall(events), 'pre_tool broke']],
  );
  assertEquals(bodies, before);
  assertWentOn(events);
});

Deno.test("a visitor's copy of a crashed call never holds the hook's own error", async () => {
  const crashes = [
    await turn({ execution: createMemoryToolExecution(), onStage: crashOn('pre_tool') }),
    await turn({
      execution: coordinator({
        begin: () => {
          throw new Error('begin down');
        },
      }),
    }),
  ];
  for (const events of crashes) {
    const seen = JSON.stringify(forClientEvents(events));
    assert(!seen.includes('pre_tool broke') && !seen.includes('begin down'));
    assert(seen.includes(DID_NOT_RUN));
  }
});

/** The memory coordinator with one method replaced. */
function coordinator(over: Partial<ToolExecutionCoordinator>): ToolExecutionCoordinator {
  return { ...createMemoryToolExecution(), ...over };
}

for (const method of ['lookup', 'begin'] as const) {
  Deno.test(`a ${method} crash fails the call as not started, and the turn goes on`, async () => {
    const events = await turn({
      execution: coordinator({
        [method]: () => {
          throw new Error(`${method} down`);
        },
      }),
    });
    assertEquals(toolFailures(events), [['hook_failed', DID_NOT_RUN]]);
    assertEquals(
      reports(events).map((e) => [e.hook, e.callId, e.errorInternal]),
      [['execution', failedCall(events), `${method} down`]],
    );
    assertWentOn(events);
  });

  Deno.test(`a TheoremError from ${method} is the store's answer, and ends the turn`, async () => {
    await assertRejects(
      () =>
        turn({
          execution: coordinator({
            [method]: () => {
              throw new TheoremError('config', 'session is full');
            },
          }),
        }),
      TheoremError,
      'session is full',
    );
  });
}

Deno.test('a settle crash keeps the real result and is reported once', async () => {
  const events = await turn({
    execution: coordinator({
      settle: () => {
        throw new Error('store down');
      },
    }),
  });
  assert(events.some((e) => e.type === 'tool' && e.tool.phase === 'complete'));
  assertEquals(toolFailures(events), []);
  const seen = reports(events);
  assertEquals(seen.length, 1);
  assertEquals(seen[0]?.hook, 'execution');
  assertEquals(seen[0]?.errorInternal, 'store down');
  assertWentOn(events);
});

Deno.test('a settle crash whose uncertain mark also fails reports both, and the turn goes on', async () => {
  const events = await turn({
    execution: coordinator({
      settle: () => {
        throw new Error('store down');
      },
      markUncertain: () => {
        throw new Error('mark down');
      },
    }),
  });
  assert(events.some((e) => e.type === 'tool' && e.tool.phase === 'complete'));
  assertEquals(
    reports(events).map((e) => [e.hook, e.errorInternal]),
    [
      ['execution', 'store down'],
      ['execution', 'mark down'],
    ],
  );
  assertWentOn(events);
});

/** A profile whose reply must have a good `code`, checked by a validator that throws. */
function validated(id: string, validation: Record<string, unknown>): void {
  registerProfile({
    type: 'text',
    id,
    identity: { handle: id },
    ...geminiModels('gemini35FlashLite'),
    maxSteps: 1,
    tools: { allow: [] },
    inputs: { text: true },
    outputs: { structured: 'validTurn', validation: { ...validation, maxRetries: 1 } },
    guardrails: { quota: { perDay: 50 } },
  });
}

/** Answers `bad` first, then `good` on the repair. */
function repaired(): TurnModel & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async *complete() {
      await Promise.resolve();
      calls += 1;
      yield { type: 'structured', structured: { code: calls === 1 ? 'bad' : 'good' } };
    },
  };
}

Deno.test('a field validator that throws fails the value, is reported, and the turn goes on', async () => {
  validated('hook_crash_field', {
    fields: {
      code: (code: unknown) => {
        if (code === 'bad') throw new Error('validator broke');
        return { isValid: true };
      },
    },
  });
  const model = repaired();
  const events = await Array.fromAsync(
    runTurn({ profile: 'hook_crash_field', input: { text: 'Go' } }, model),
  );
  assertEquals(model.calls(), 2);
  assertEquals(
    reports(events).map((e) => [e.hook, e.errorInternal]),
    [['outputs.validation', 'validator broke']],
  );
  const structured = events.find((e) => e.type === 'structured');
  assert(structured?.type === 'structured');
  assertEquals(structured.structured, { code: 'good' });
});

Deno.test('a compaction trigger that throws falls back to the threshold and is reported', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'compactor', system: 'Summarise.' },
      tools: { allow: [] },
      id: 'hook_crash.compactor',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      inputs: { text: true },
      guardrails: { detect: 'ignore' },
    }),
  );
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'speaker', system: 'Answer.' },
      tools: { allow: [] },
      id: 'hook_crash.speaker',
      models: {
        hookCrashModel: {
          ...HOST_BINDINGS.gemini35FlashLite,
          compaction: {
            maxTokens: 1000,
            compactAt: 0.5,
            previousExchanges: 2,
            timing: 'after',
            meter: 'input',
            profile: 'hook_crash.compactor',
            trigger: () => {
              throw new Error('trigger broke');
            },
          },
        },
      },
      inputs: { text: true },
      guardrails: { detect: 'ignore' },
    }),
  );
  const model: TurnModel = {
    async *complete() {
      await Promise.resolve();
      yield { type: 'text', text: 'response' };
      yield { type: 'tokens', tokens: { input: 800, output: 50, total: 850 } };
    },
  };
  const events = await Array.fromAsync(
    runTurn(
      {
        profile: 'hook_crash.speaker',
        input: {
          text: 'q',
          history: [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
          ],
        },
      },
      model,
    ),
  );
  assertEquals(
    reports(events).map((e) => [e.hook, e.errorInternal]),
    [['compaction.trigger', 'trigger broke']],
  );
  const done = events.find((e) => e.type === 'done');
  assert(done?.type === 'done');
  assertEquals(done.compaction?.needed, true);
});
