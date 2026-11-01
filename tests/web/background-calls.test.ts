import { assert, assertEquals } from '@std/assert';
import {
  defaultKernelScope,
  type ProfileDefinition,
  registerTool,
  type ToolBackgroundHandle,
  type ToolBackgroundService,
  type ToolOperationClaim,
  type ToolOperationIdentity,
  type TurnEvent,
  type TurnHistoryMessage,
  type TurnModel,
  toolOperationOutcomeSchema,
  toolOperationReplySchema,
  z,
} from '../../mod.ts';
import { createHttpTransport } from '../../web/src/client/transport.ts';
import {
  checkpointIdentity,
  checkpointOwnershipKey,
  requireOwnedCheckpoint,
} from '../../web/src/server/checkpoint-ownership.ts';
import {
  createMemoryConversationStore,
  createMemorySessionStore,
  createTheoremHandler,
} from '../../web/src/server/mod.ts';
import { sessionToolCoordinator } from '../../web/src/server/tool-operations.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';

const PROFILE: ProfileDefinition = {
  type: 'text',
  id: 'web-background',
  identity: { handle: 'helper', system: 'You help.' },
  models: { stub: { protocol: 'scripted', provider: 'scripted', apiId: 'stub-model' } },
  tools: { allow: ['web_slow_job'] },
  inputs: { text: true },
  guardrails: { detect: 'ignore' },
};

/** A model that calls the tool in its first step, then answers. */
function caller(): TurnModel {
  let step = 0;
  return {
    complete: () =>
      (async function* () {
        await Promise.resolve();
        step += 1;
        if (step === 1) {
          yield {
            type: 'tool' as const,
            tool: { name: 'web_slow_job', callId: 'call_1', arguments: {} },
          };
          return;
        }
        yield { type: 'text' as const, text: 'Looking into it.' };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
      })(),
  };
}

const IDENTITY: ToolOperationIdentity = {
  operationId: 'op_1',
  callId: 'call_1',
  profileId: PROFILE.id,
  toolId: 'web_slow_job',
  invocationHash: 'hash_1',
};

const CALL = { operationId: 'op_1', callId: 'call_1', name: 'web_slow_job', at: 1 };

const REPLY = toolOperationReplySchema.parse({
  event: { type: 'tool', tool: { ...CALL, phase: 'background', readBack: 'still running' } },
  replay: { modelResult: { finding: 'still running' } },
});

async function detachedCall() {
  const store = createMemorySessionStore();
  const stores = {
    capacity: undefined,
    async mutate<T>(id: string, change: (state: never) => T) {
      const saved = await store.load(id);
      const state = (saved?.state ?? {
        version: 3,
        operations: {},
        permissions: [],
        gates: {},
        providerCheckpoints: [],
      }) as never;
      const value = await change(state);
      await store.compareAndSwap(id, saved?.revision ?? null, state);
      return value;
    },
  };
  const coordinator = sessionToolCoordinator(stores as never, 'session');
  const begun = await coordinator.begin(IDENTITY);
  assert(begun.kind === 'acquired');
  const claim: ToolOperationClaim = { ...IDENTITY, claimToken: begun.claimToken };
  await coordinator.detach?.(claim, REPLY);
  const operations = async () => (await store.load('session'))?.state.operations ?? {};
  return { coordinator, claim, operations };
}

const OUTCOME = toolOperationOutcomeSchema.parse({
  effects: 'completed',
  event: {
    type: 'tool',
    tool: { ...CALL, phase: 'complete', arguments: {}, output: {}, readBack: 'the real result' },
  },
  replay: { modelResult: { finding: 'the real result' } },
});

Deno.test('a detached call reads its reply back until it settles', async () => {
  const { coordinator } = await detachedCall();
  assertEquals(await coordinator.lookup?.(IDENTITY), { kind: 'background', reply: REPLY });
  assertEquals(await coordinator.begin(IDENTITY), { kind: 'background', reply: REPLY });
});

Deno.test('a late settlement keeps the checkpoint this turn saved', async () => {
  const { coordinator, claim, operations } = await detachedCall();
  const before = await checkpointOwnershipKey('checkpoint', await operations());
  await coordinator.settle(claim, OUTCOME);
  const settled = await operations();
  assertEquals(settled.op_1.status, 'settled');
  assertEquals(await checkpointOwnershipKey('checkpoint', settled), before);
});

Deno.test('a shutdown mark keeps the checkpoint this turn saved', async () => {
  const { coordinator, claim, operations } = await detachedCall();
  const before = await checkpointOwnershipKey('checkpoint', await operations());
  await coordinator.markUncertain(claim, 'execution_interrupted');
  const marked = await operations();
  assertEquals(marked.op_1.status, 'uncertain');
  assertEquals(await checkpointOwnershipKey('checkpoint', marked), before);
});

Deno.test('history holding the reply owns a checkpoint, before and after the settlement', async () => {
  const { coordinator, claim, operations } = await detachedCall();
  const checkpoint = {
    protocol: 'x',
    provider: 'p',
    version: 1,
    apiId: 'm',
    compatibilityKey: 'k',
    coveredHistoryLength: 1,
    coveredHistoryHash: 'h',
    data: {},
  };
  const history: TurnHistoryMessage[] = [
    { role: 'tool', tool_call_id: 'call_1', name: 'web_slow_job', content: 'still running' },
  ];
  const identity = await checkpointIdentity(checkpoint);
  const saved = [`${identity}:an older epoch`];
  assert(await requireOwnedCheckpoint(saved, checkpoint, await operations(), history));
  await coordinator.settle(claim, OUTCOME);
  assert(await requireOwnedCheckpoint(saved, checkpoint, await operations(), history));
});

Deno.test('a chat turn replies now, and the session keeps the late result', async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  registerFixtureProviders(defaultKernelScope);
  registerTool({
    type: 'function',
    name: 'web_slow_job',
    description: 'A slow job.',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    background: 'always',
    input: z.strictObject({}),
    output: z.object({ done: z.string() }),
    handler: async () => {
      await held;
      return { done: 'late' };
    },
  });
  try {
    const sessionStore = createMemorySessionStore();
    const handles: ToolBackgroundHandle[] = [];
    const late: TurnEvent[] = [];
    const sessions: string[] = [];
    const service: ToolBackgroundService = {
      detached: (handle) => handles.push(handle),
      event: (event) => {
        late.push(event);
      },
    };
    const handler = createTheoremHandler({
      profile: PROFILE,
      provider: () => fixtureHostOptions(caller()),
      conversationStore: createMemoryConversationStore(),
      sessionStore,
      onError: (err) => console.error(err),
      background: ({ sessionId }) => {
        sessions.push(sessionId);
        return service;
      },
    });
    const transport = createHttpTransport({
      endpoint: 'http://host.test/api/theorem',
      fetch: (url, init) => handler(new Request(url, init)),
    });
    const events: TurnEvent[] = [];
    await transport.turn({ input: { text: 'hello' } }, (line) => {
      if (line.type !== 'conversation' && line.type !== 'unsupported' && line.type !== 'malformed')
        events.push(line);
    });
    assertEquals(
      events.filter((event) => event.type === 'text').map((event) => event.text),
      ['Looking into it.'],
    );
    assertEquals(handles.length, 1);
    const running = await sessionStore.load(sessions[0]);
    assertEquals(Object.values(running?.state.operations ?? {})[0]?.status, 'background');
    release();
    await handles[0].done;
    const settled = await sessionStore.load(sessions[0]);
    const operation = Object.values(settled?.state.operations ?? {})[0];
    assert(operation?.status === 'settled');
    assertEquals(operation.outcome.event.tool.phase, 'complete');
    assert(operation.reply);
    assert(late.some((event) => event.type === 'tool' && event.tool.phase === 'complete'));
  } finally {
    release();
  }
});
