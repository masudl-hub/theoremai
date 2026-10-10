import { assert, assertEquals, assertRejects } from '@std/assert';
import { withPublicWording } from '@theoremjs/agents/guardrails';
import {
  defaultKernelScope,
  invokeTool,
  registerProfile,
  registerTool,
  type ToolOperationIdentity,
  type TurnEvent,
  z,
} from '../../mod.ts';
import { createMemorySessionStore, createTheoremHostHandler } from '../../react/src/server/mod.ts';
import { sessionToolCoordinator } from '../../react/src/server/tool-operations.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { sqliteSessionStore } from '../fixtures/sqlite-session-store.ts';

async function post(
  handler: (request: Request) => Promise<Response>,
  route: string,
  body: unknown,
) {
  const response = await handler(
    new Request(`https://operations.test/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    events: (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TurnEvent),
  };
}

for (const backend of ['memory', 'sqlite'] as const) {
  Deno.test(`${backend}: output validation after dispatch cannot restore an approval`, async () => {
    const directory = backend === 'sqlite' ? await Deno.makeTempDir() : undefined;
    try {
      const store = directory
        ? sqliteSessionStore(`${directory}/state.sqlite`)
        : createMemorySessionStore();
      const name = `uncertain_validation_${backend}`;
      let effects = 0;
      registerTool({
        type: 'function',
        name,
        description: 'Count a dispatch',
        category: 'test',
        access: 'read-write',
        permission: 'always_confirm',
        loadTier: 'T0',
        paths: ['*'],
        input: z.object({}),
        output: z.object({ count: z.number() }).refine(() => {
          throw new Error('validator failed after dispatch');
        }),
        handler: () => ({ count: ++effects }),
      });
      const options = {
        profile: { type: 'host' as const, id: name, tools: { allow: [name] } },
        sessionStore: store,
        session: () => name,
      };
      const first = createTheoremHostHandler(options);
      const second = createTheoremHostHandler(options);
      const issued = (await post(first, 'call', { name, input: {} })).events.findLast(
        (event) => event.type === 'tool' && event.tool.phase === 'gate',
      );
      assert(issued?.type === 'tool' && issued.tool.operationId);
      const answer = {
        gateId: issued.tool.callId,
        operationId: issued.tool.operationId,
        decision: 'approve',
      };
      await post(first, 'invoke', answer);
      const state = (await store.load(name))?.state;
      assertEquals(state?.operations[issued.tool.operationId].status, 'uncertain');
      assertEquals(Object.hasOwn(state?.gates ?? {}, issued.tool.operationId), false);
      assertEquals((await post(second, 'invoke', answer)).status, 503);
      assertEquals(effects, 1);
    } finally {
      if (directory) await Deno.remove(directory, { recursive: true });
    }
  });
}

Deno.test('claims reject a stale worker and allow the original worker to settle uncertainty', async () => {
  const store = createMemorySessionStore();
  const coordinator = sessionToolCoordinator(
    {
      async mutate(id, change) {
        const snapshot = await store.load(id);
        const state = snapshot?.state ?? {
          version: 3 as const,
          operations: {},
          permissions: [],
          gates: {},
          providerCheckpoints: [],
        };
        const result = change(state);
        const written = await store.compareAndSwap(id, snapshot?.revision ?? null, state);
        assert(written.written);
        return result;
      },
    },
    'claims',
  );
  const identity: ToolOperationIdentity = {
    operationId: 'operation',
    callId: 'call',
    profileId: 'profile',
    toolId: 'tool',
    invocationHash: 'hash',
  };
  const acquired = await coordinator.begin(identity);
  assert(acquired.kind === 'acquired');
  const claim = { ...identity, claimToken: acquired.claimToken };
  await assertRejects(() =>
    coordinator.markUncertain({ ...claim, claimToken: 'other-worker' }, 'worker_lost'),
  );
  await coordinator.markUncertain(claim, 'worker_lost');
  assertEquals(await coordinator.begin(identity), { kind: 'uncertain' });
  await coordinator.settle(claim, {
    event: {
      type: 'tool',
      tool: {
        operationId: 'operation',
        callId: 'call',
        name: 'tool',
        at: 0,
        phase: 'complete',
        output: { done: true },
      },
    },
    effects: 'completed',
    replay: {
      outputRaw: { done: true },
      modelResult: {
        finding: 'done',
        modelText: 'guarded text',
        provenance: { origin: 'http', tool: 'tool', depth: 1 },
        suspicious: [{ rule: 'test', severity: 'high' }],
      },
    },
  });
  const replay = await coordinator.begin(identity);
  assert(replay.kind === 'settled');
  assertEquals(replay.outcome.replay.modelResult?.suspicious?.[0].rule, 'test');
  await assertRejects(() => coordinator.begin({ ...identity, invocationHash: 'different' }));
});

Deno.test('unresolved claims survive idle and capacity eviction', async () => {
  const store = createMemorySessionStore({ ttlMs: 1, maxSessions: 1 });
  const state = {
    version: 3 as const,
    permissions: [],
    gates: {},
    providerCheckpoints: [],
    operations: {
      action: {
        status: 'uncertain' as const,
        operationId: 'action',
        callId: 'call',
        profileId: 'p',
        toolId: 't',
        invocationHash: 'h',
        claimToken: 'worker',
        reason: 'worker_lost' as const,
        detectedAt: 0,
      },
    },
  };
  await store.compareAndSwap('protected', null, state);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals((await store.load('protected'))?.state.operations.action.status, 'uncertain');
  await assertRejects(async () => {
    await store.compareAndSwap('other', null, { ...state, operations: {} });
  });
});

Deno.test('kernel replay preserves guarded read-back without dispatching the handler', async () => {
  let effects = 0;
  const name = 'kernel_operation_replay';
  registerTool({
    type: 'function',
    name,
    description: 'Count a dispatch',
    category: 'test',
    access: 'read-write',
    permission: 'auto',
    loadTier: 'T0',
    paths: ['*'],
    input: z.object({}),
    output: z.object({ count: z.number() }),
    handler: () => ({ count: ++effects }),
  });
  registerProfile({ type: 'host', id: name, tools: { allow: [name] } });
  let outcome: import('../../mod.ts').ToolOperationOutcome | undefined;
  const execution: import('../../mod.ts').ToolExecutionCoordinator = {
    begin: () =>
      Promise.resolve(
        outcome ? { kind: 'settled', outcome } : { kind: 'acquired', claimToken: 'worker' },
      ),
    settle: (_claim, result) => {
      outcome = result;
      return Promise.resolve();
    },
    settleNotStarted: () => Promise.reject(new Error('Expected dispatch')),
    markUncertain: () => Promise.reject(new Error('Expected settlement')),
  };
  const run = async () => {
    const events: TurnEvent[] = [];
    for await (const event of invokeTool({
      profile: name,
      name,
      input: {},
      operationId: 'fixed-operation',
      callId: 'fixed-call',
      execution,
    }))
      events.push(event);
    return events.find((event) => event.type === 'tool' && event.tool.phase === 'complete');
  };
  const first = await run();
  assert(outcome?.replay.modelResult?.modelText);
  assertEquals(await run(), first);
  assertEquals(effects, 1);
});

Deno.test('settlement write failure retains uncertainty before the client receives completion', async () => {
  const memory = createMemorySessionStore();
  let rejected = false;
  let effects = 0;
  const name = 'settlement_write_failure';
  registerTool({
    type: 'function',
    name,
    description: 'Count a dispatch',
    category: 'test',
    access: 'read-write',
    permission: 'always_confirm',
    loadTier: 'T0',
    paths: ['*'],
    input: z.object({}),
    output: z.object({ count: z.number() }),
    handler: () => ({ count: ++effects }),
  });
  const store: import('../../react/src/server/mod.ts').TheoremSessionStore = {
    load: (id) => memory.load(id),
    compareAndSwap(id, revision, next) {
      if (
        !rejected &&
        Object.values(next.operations).some((operation) => operation.status === 'settled')
      ) {
        rejected = true;
        return Promise.reject(new Error('Settlement storage unavailable'));
      }
      return memory.compareAndSwap(id, revision, next);
    },
  };
  const options = {
    profile: { type: 'host' as const, id: name, tools: { allow: [name] } },
    sessionStore: store,
    session: () => name,
  };
  const handler = createTheoremHostHandler(options);
  const issued = (await post(handler, 'call', { name, input: {} })).events.findLast(
    (event) => event.type === 'tool' && event.tool.phase === 'gate',
  );
  assert(issued?.type === 'tool' && issued.tool.operationId);
  const answer = {
    gateId: issued.tool.callId,
    operationId: issued.tool.operationId,
    decision: 'approve',
  };
  const failed = await post(handler, 'invoke', answer);
  assertEquals(
    failed.events.some((event) => event.type === 'tool' && event.tool.phase === 'complete'),
    false,
  );
  const operation = (await memory.load(name))?.state.operations[issued.tool.operationId];
  assert(operation?.status === 'uncertain');
  assertEquals(operation.reason, 'settlement_write_failed');
  assertEquals((await post(createTheoremHostHandler(options), 'invoke', answer)).status, 503);
  assertEquals(effects, 1);
});

Deno.test('ready invocation survives a pre-dispatch validator fault and rejects edited retries', async () => {
  const store = createMemorySessionStore();
  let fail = false;
  let effects = 0;
  const name = 'ready_validator_fault';
  registerTool({
    type: 'function',
    name,
    description: 'Count a dispatch',
    category: 'test',
    access: 'read-write',
    permission: 'always_confirm',
    loadTier: 'T0',
    paths: ['*'],
    input: z.object({ id: z.string() }).refine(() => {
      if (fail) {
        fail = false;
        throw new Error('Pre-dispatch validator fault');
      }
      return true;
    }),
    output: z.object({ count: z.number() }),
    handler: () => ({ count: ++effects }),
  });
  const options = {
    profile: { type: 'host' as const, id: name, tools: { allow: [name] } },
    sessionStore: store,
    session: () => name,
  };
  const handler = createTheoremHostHandler(options);
  const issued = (await post(handler, 'call', { name, input: { id: 'accepted' } })).events.findLast(
    (event) => event.type === 'tool' && event.tool.phase === 'gate',
  );
  assert(issued?.type === 'tool' && issued.tool.operationId);
  const answer = {
    gateId: issued.tool.callId,
    operationId: issued.tool.operationId,
    decision: 'approve',
  };
  fail = true;
  await post(handler, 'invoke', answer);
  assertEquals((await store.load(name))?.state.operations[issued.tool.operationId].status, 'ready');
  assertEquals(effects, 0);
  assertEquals(
    (await post(handler, 'invoke', { ...answer, input: { id: 'changed' } })).status,
    400,
  );
  const retry = await post(createTheoremHostHandler(options), 'invoke', answer);
  assertEquals(
    retry.events.some((event) => event.type === 'tool' && event.tool.phase === 'complete'),
    true,
  );
  assertEquals(effects, 1);
});

Deno.test('a pre-dispatch sign-in gate replaces ready authority under the same operation ID', async () => {
  const store = createMemorySessionStore();
  let effects = 0;
  const name = 'ready_sign_in_gate';
  registerTool({
    type: 'function',
    name,
    description: 'Count a signed-in dispatch',
    category: 'test',
    access: 'read-write',
    permission: 'always_confirm',
    loadTier: 'T0',
    paths: ['*'],
    input: z.object({}),
    output: z.object({ count: z.number() }),
    auth: {
      type: 'bearer',
      slot: 'operation-service',
      service: 'Operation service',
      onUnauthenticated: 'gate',
    },
    handler: () => ({ count: ++effects }),
  });
  const handler = createTheoremHostHandler({
    profile: { type: 'host', id: name, tools: { allow: [name] } },
    sessionStore: store,
    session: () => name,
  });
  const issued = (await post(handler, 'call', { name, input: {} })).events.findLast(
    (event) => event.type === 'tool' && event.tool.phase === 'gate',
  );
  assert(issued?.type === 'tool' && issued.tool.operationId);
  const approved = await post(handler, 'invoke', {
    gateId: issued.tool.callId,
    operationId: issued.tool.operationId,
    decision: 'approve',
  });
  const auth = approved.events.findLast(
    (event) => event.type === 'tool' && event.tool.phase === 'gate',
  );
  assert(auth?.type === 'tool' && auth.tool.phase === 'gate');
  assertEquals(auth.tool.gate.kind, 'auth');
  assertEquals(auth.tool.operationId, issued.tool.operationId);
  const state = (await store.load(name))?.state;
  assertEquals(Object.hasOwn(state?.operations ?? {}, issued.tool.operationId), false);
  assertEquals(state?.gates[issued.tool.operationId].gate.kind, 'auth');
  assertEquals(effects, 0);
});

Deno.test('promotion refusal is saved as not started before its terminal event', async () => {
  const name = 'promotion_not_started';
  let effects = 0;
  registerTool({
    type: 'function',
    name,
    description: 'Count a dispatch',
    category: 'test',
    access: 'read-write',
    permission: 'auto',
    loadTier: 'T0',
    paths: ['*'],
    input: z.object({}),
    output: z.object({ count: z.number() }),
    handler: () => ({ count: ++effects }),
  });
  registerFixtureProviders(defaultKernelScope);
  registerProfile({
    type: 'text',
    id: name,
    identity: { handle: 'Promotion test' },
    models: { default: { provider: 'openrouter', apiId: 'mock' } },
    inputs: { text: true },
    tools: { allow: [name] },
  });
  let saved: import('../../mod.ts').ToolOperationOutcome | undefined;
  const execution: import('../../mod.ts').ToolExecutionCoordinator = {
    begin: () => Promise.reject(new Error('Refusal must not acquire a body claim')),
    settle: () => Promise.reject(new Error('Refusal must not settle a body claim')),
    markUncertain: () => Promise.reject(new Error('Refusal has no body claim')),
    settleNotStarted: (_identity, outcome) => {
      saved = outcome;
      return Promise.resolve();
    },
  };
  for await (const event of invokeTool({
    profile: name,
    name,
    input: {},
    promoted: ['not-allowed'],
    execution,
  })) {
    if (event.type === 'tool' && event.tool.phase === 'error') {
      assertEquals(saved?.effects, 'not_started');
      assertEquals(saved?.replay.callNotStarted, true);
      assertEquals(saved && withPublicWording(saved.event), event);
    }
  }
  assert(saved);
  assertEquals(effects, 0);
});

Deno.test('shared session storage cannot approve a gate through another profile', async () => {
  const store = createMemorySessionStore();
  let effects = 0;
  const name = 'profile_owned_operation';
  registerTool({
    type: 'function',
    name,
    description: 'Count a dispatch',
    category: 'test',
    access: 'read-write',
    permission: 'always_confirm',
    loadTier: 'T0',
    paths: ['*'],
    input: z.object({}),
    output: z.object({ count: z.number() }),
    handler: () => ({ count: ++effects }),
  });
  const handler = (id: string) =>
    createTheoremHostHandler({
      profile: { type: 'host', id, tools: { allow: [name] } },
      sessionStore: store,
      session: () => 'shared-profile-session',
    });
  const owner = handler('operation-owner');
  const other = handler('other-profile');
  const issued = (await post(owner, 'call', { name, input: {} })).events.findLast(
    (event) => event.type === 'tool' && event.tool.phase === 'gate',
  );
  assert(issued?.type === 'tool' && issued.tool.operationId);
  const answer = {
    gateId: issued.tool.callId,
    operationId: issued.tool.operationId,
    decision: 'approve',
  };
  assertEquals((await post(other, 'invoke', answer)).status, 400);
  assertEquals(effects, 0);
  const accepted = await post(owner, 'invoke', answer);
  assertEquals(
    accepted.events.some((event) => event.type === 'tool' && event.tool.phase === 'complete'),
    true,
  );
  const operation = (await store.load('shared-profile-session'))?.state.operations[
    issued.tool.operationId
  ];
  assert(operation?.status === 'settled');
  assertEquals(operation.profileId, 'operation-owner');
  assertEquals(effects, 1);
});
