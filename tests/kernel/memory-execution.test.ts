import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  createMemoryToolExecution,
  invokeTool,
  registerProfile,
  registerTool,
  type ToolOperationIdentity,
  type ToolOperationOutcome,
  type TurnEvent,
  z,
} from '../../mod.ts';

function identity(operationId: string): ToolOperationIdentity {
  return {
    operationId,
    callId: `call-${operationId}`,
    profileId: 'p',
    toolId: 't',
    invocationHash: 'h',
  };
}

const OUTCOME = {
  event: { type: 'tool', tool: { phase: 'complete' } },
  effects: 'completed',
  replay: {},
} as unknown as ToolOperationOutcome;

Deno.test('a memory coordinator hands out one claim and reads back what settled', async () => {
  const execution = createMemoryToolExecution();
  const op = identity('a');
  assertEquals(await execution.lookup(op), undefined);
  const first = await execution.begin(op);
  assert(first.kind === 'acquired');
  assertEquals(await execution.begin(op), { kind: 'running' });
  await execution.settle({ ...op, claimToken: first.claimToken }, OUTCOME);
  assertEquals(await execution.lookup(op), { kind: 'settled', outcome: OUTCOME });
  assertEquals(await execution.begin(op), { kind: 'settled', outcome: OUTCOME });
});

Deno.test('a memory coordinator refuses a claim token it did not issue', async () => {
  const execution = createMemoryToolExecution();
  const op = identity('a');
  await execution.begin(op);
  await assertRejects(() => execution.settle({ ...op, claimToken: 'forged' }, OUTCOME));
  await assertRejects(() =>
    execution.markUncertain({ ...op, claimToken: 'forged' }, 'worker_lost'),
  );
});

Deno.test('a memory coordinator keeps an interrupted claim uncertain', async () => {
  const execution = createMemoryToolExecution();
  const op = identity('a');
  const claim = await execution.begin(op);
  assert(claim.kind === 'acquired');
  await execution.markUncertain({ ...op, claimToken: claim.claimToken }, 'execution_interrupted');
  assertEquals(await execution.begin(op), { kind: 'uncertain' });
});

Deno.test('a memory coordinator cannot settle a running operation as not started', async () => {
  const execution = createMemoryToolExecution();
  const op = identity('a');
  await execution.begin(op);
  await assertRejects(() => execution.settleNotStarted(op, OUTCOME));
  await execution.settleNotStarted(identity('b'), OUTCOME);
});

Deno.test('a full memory coordinator refuses new operations and keeps the old ones', async () => {
  const execution = createMemoryToolExecution({ maxOperations: 1 });
  const op = identity('a');
  await execution.begin(op);
  await assertRejects(() => execution.begin(identity('b')));
  await assertRejects(() => execution.settleNotStarted(identity('c'), OUTCOME));
  assertEquals(await execution.lookup(op), { kind: 'running' });
});

Deno.test('a page-answered tool dispatches against a memory coordinator', async () => {
  const name = 'memory_execution_page_tool';
  registerTool({
    type: 'function',
    name,
    description: 'Ask the page',
    category: 'test',
    access: 'read-write',
    permission: 'auto',
    loadTier: 'T0',
    paths: ['*'],
    answeredBy: 'page',
    input: z.object({}),
    output: z.object({ text: z.string() }),
  });
  registerProfile({ type: 'host', id: name, tools: { allow: [name] } });
  const events: TurnEvent[] = [];
  for await (const event of invokeTool({
    profile: name,
    name,
    input: {},
    execution: createMemoryToolExecution(),
    pageExecution: {
      dispatch: () =>
        Promise.resolve({ grantId: 'grant', result: Promise.resolve({ output: { text: 'ok' } }) }),
    },
  })) {
    events.push(event);
  }
  const phases = events.flatMap((event) => (event.type === 'tool' ? [event.tool.phase] : []));
  assert(phases.includes('dispatch'), `phases: ${phases.join(',')}`);
  assert(phases.includes('complete'), `phases: ${phases.join(',')}`);
});
