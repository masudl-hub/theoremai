import { z } from 'zod';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import type { KernelScope } from '../../src/kernel/scope.ts';
import type { ToolStepCallResult } from '../../src/kernel/tools/run.ts';
import type { ToolDefinitionInput } from '../../src/kernel/tools/types.ts';
import { createTestKernelScope } from '../fixtures/provider-scope.ts';

const PROFILE = 'run_tool_host';

function tool(
  name: string,
  permission: 'auto' | 'always_confirm',
  handler: () => unknown,
): ToolDefinitionInput {
  return {
    type: 'function',
    name,
    description: name,
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission,
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    labels: { activity: 'Looking it up' },
    handler,
  };
}

function scopeWithTools(): KernelScope {
  const scope = createTestKernelScope();
  scope.tools.register(tool('finds', 'auto', () => ({ finding: 'found' })));
  scope.tools.register(tool('asks', 'always_confirm', () => ({ finding: 'asked' })));
  scope.tools.register(
    tool('breaks', 'auto', () => {
      throw new Error('broke');
    }),
  );
  scope.profiles.register({
    type: 'host',
    id: PROFILE,
    tools: { allow: ['finds', 'asks', 'breaks'], parallel: true },
  });
  return scope;
}

Deno.test('runTool gives how a call settled, under the id its events carry', async () => {
  const scope = scopeWithTools();
  const done = await scope.runTool({
    profile: PROFILE,
    name: 'finds',
    input: {},
  });
  assertEquals(done.phase, 'complete');
  assertEquals(done.phase === 'complete' ? done.output : undefined, {
    finding: 'found',
  });
  assertEquals(done.activity, 'Looking it up');
  const ids = new Set(
    done.events.flatMap((event) => (event.type === 'tool' ? [event.tool.callId] : [])),
  );
  assertEquals([...ids], [done.callId]);
  assertEquals(done.events.at(-1)?.type, 'done');
});

Deno.test('runTool gives a held call as its gate, with the operation its resume carries', async () => {
  const held = await scopeWithTools().runTool({
    profile: PROFILE,
    name: 'asks',
    input: {},
  });
  assertEquals(held.phase, 'gate');
  assertEquals(typeof held.operationId, 'string');
});

Deno.test('runTool gives a failed call as its failure', async () => {
  const failed = await scopeWithTools().runTool({
    profile: PROFILE,
    name: 'breaks',
    input: {},
  });
  assertEquals(failed.phase, 'error');
  assertEquals(failed.phase === 'error' ? failed.failure.kind : undefined, 'failed');
});

Deno.test("runToolStep gives each call's end by its place, named or not", async () => {
  const results: ToolStepCallResult[] = await Array.fromAsync(
    scopeWithTools().runToolStep({
      profile: PROFILE,
      calls: [
        { name: 'asks', input: {} },
        { name: 'finds', callId: 'c2', input: {} },
        { name: 'finds', input: {} },
      ],
    }),
  );
  const byIndex = results.toSorted((a, b) => a.index - b.index);
  assertEquals(
    byIndex.map((result) => [result.index, result.name, result.phase]),
    [
      [0, 'asks', 'gate'],
      [1, 'finds', 'complete'],
      [2, 'finds', 'complete'],
    ],
  );
  assertEquals(byIndex[1]?.callId, 'c2');
  for (const result of byIndex) {
    const own = result.events.every(
      (event) => event.type === 'tool' && event.tool.callId === result.callId,
    );
    assertEquals(own, true);
  }
  assertEquals(new Set(byIndex.map((result) => result.callId)).size, 3);
});
