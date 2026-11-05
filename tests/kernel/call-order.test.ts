import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { z } from 'zod';
import { TheoremError } from '../../src/guardrails/error.ts';
import { invokeTool, registerProfile, registerTool } from '../../src/kernel/default-scope.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { StageHandler } from '../../src/kernel/stages.ts';
import { stepCallIds, withCallOrder } from '../../src/kernel/tools/call-order.ts';
import type { TurnEvent, TurnModel } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

/** A profile with two ordered tools that log their input, and a model that calls them in one step. */
function orderedProbe(prefix: string) {
  const log: unknown[] = [];
  const staged: unknown[] = [];
  const first = `${prefix}_first`;
  const second = `${prefix}_second`;
  for (const [name, wait] of [
    [first, 5],
    [second, 0],
  ] as const) {
    registerTool({
      type: 'function',
      name,
      description: name,
      category: 'test',
      access: 'read-only',
      paths: ['*'],
      loadTier: 'T0',
      permission: 'auto',
      after: true,
      input: z.object({ q: z.string().optional() }),
      output: z.object({}),
      handler: async (input) => {
        log.push([name, input]);
        await new Promise((done) => setTimeout(done, wait));
        return {};
      },
    });
  }
  const id = `${prefix}_bot`;
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id,
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 2,
      tools: { allow: [first, second], parallel: true },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const run = (after: string[]): Promise<TurnEvent[]> => {
    let step = 0;
    const provider: TurnModel = {
      async *complete() {
        if (step++ > 0) {
          yield { type: 'text', text: 'done' };
          return;
        }
        const name = first;
        yield { type: 'tool', tool: { name, arguments: { q: 'x', after }, callId: 'c1' } };
        yield { type: 'tool', tool: { name: second, arguments: {}, callId: 'c2' } };
      },
    };
    return Array.fromAsync(
      runTurn(
        {
          profile: id,
          input: { text: 'go' },
          onStage: (ctx) => {
            if (ctx.stage === 'pre_tool') staged.push(ctx.input);
            return undefined;
          },
        },
        provider,
      ),
    );
  };
  return { log, staged, first, second, id, run };
}

Deno.test('after starts a call once the named tool settles, and nothing downstream reads it', async () => {
  const probe = orderedProbe('after_order');
  await probe.run([probe.second]);
  assertEquals(probe.log, [
    [probe.second, {}],
    [probe.first, { q: 'x' }],
  ]);
  assertEquals(probe.staged, [{ q: 'x' }, {}]);
});

Deno.test('without after a parallel step keeps the order the calls start in', async () => {
  const probe = orderedProbe('after_none');
  await probe.run([]);
  assertEquals(probe.log, [
    [probe.first, { q: 'x' }],
    [probe.second, {}],
  ]);
});

Deno.test('after a tool with no other call in the step fails the call', async () => {
  const probe = orderedProbe('after_unknown');
  const events = await probe.run(['nope']);
  const failed = events.flatMap((event) =>
    event.type === 'tool' && event.tool.phase === 'error' ? [event.tool.failure.code] : [],
  );
  assertEquals(failed, ['wait_unknown']);
  assertEquals(probe.log, [[probe.second, {}]]);
});

Deno.test('after outside a step waits on nothing, and a resumed call drops it', async () => {
  const probe = orderedProbe('after_outside');
  const call = {
    profile: probe.id,
    name: probe.first,
    input: { q: 'x', after: [probe.second] },
  };
  await Array.fromAsync(invokeTool(call));
  assertEquals(probe.log, [[probe.first, { q: 'x' }]]);
  probe.log.length = 0;
  const onStage: StageHandler = (ctx) =>
    ctx.stage === 'pre_tool' ? { confirm: { summary: 'The host asks.' } } : undefined;
  await Array.fromAsync(
    invokeTool({ ...call, onStage, resume: { granted: true, gateKind: 'confirmation' } }),
  );
  assertEquals(probe.log, [[probe.first, { q: 'x' }]]);
});

Deno.test('after reaches the model only on a tool that sets it', () => {
  const tool = {
    type: 'function' as const,
    description: 'probe',
    category: 'test',
    access: 'read-only' as const,
    paths: ['*'],
    loadTier: 'T0' as const,
    permission: 'auto' as const,
    input: z.object({}),
    output: z.object({}),
    handler: () => Promise.resolve({}),
  };
  const fields = (registered: object) =>
    Object.keys((registered as { inputSchema: { properties: object } }).inputSchema.properties);
  assertEquals(fields(registerTool({ ...tool, name: 'after_plain' })), []);
  assertEquals(fields(registerTool({ ...tool, name: 'after_set', after: true })), ['after']);
});

Deno.test('after is refused on a tool whose input already has the field', () => {
  assertThrows(
    () => withCallOrder('own', z.object({ after: z.string() })),
    TheoremError,
    "Tool 'own' sets after",
  );
});

Deno.test('after is refused on an input that is not an object', () => {
  assertThrows(() => withCallOrder('text', z.string()), TheoremError, "Tool 'text' sets after");
});

Deno.test('after reaches each option of a union', () => {
  const kinds = withCallOrder(
    'kinds',
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a') }),
      z.object({ kind: z.literal('b') }),
    ]),
  );
  assertEquals(kinds.parse({ kind: 'b', after: ['x'] }), { kind: 'b', after: ['x'] });
  const either = withCallOrder('either', z.union([z.object({ a: z.string() }), z.object({})]));
  assertEquals(either.parse({ after: ['x'] }), { after: ['x'] });
});

Deno.test('a call outside a step has nothing to wait on', () => {
  assertEquals(stepCallIds(['search'], 'call_1', undefined), []);
  assertEquals(stepCallIds(['search'], 'call_1', []), ['search']);
});
