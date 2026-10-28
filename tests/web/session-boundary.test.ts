import { assert, assertEquals, assertRejects } from '@std/assert';
import type { ProviderCheckpoint } from '../../mod.ts';
import {
  createMemorySessionStore,
  createTheoremSessionBoundary,
} from '../../web/src/server/mod.ts';

const checkpoint: ProviderCheckpoint = {
  protocol: 'fixture',
  provider: 'provider',
  version: 1,
  apiId: 'model',
  compatibilityKey: 'connection',
  coveredHistoryLength: 0,
  coveredHistoryHash: 'history',
  data: { cursor: 'one' },
};
const request = new Request('https://boundary.test');

Deno.test('live boundary refuses unowned or edited state and isolates authorized conversations', async () => {
  const store = createMemorySessionStore();
  const first = await createTheoremSessionBoundary({
    request,
    session: () => 'first',
    sessionStore: store,
  });
  const open = { type: 'open' as const, resume: { providerState: checkpoint, awayMs: 10 } };
  await assertRejects(() => first.prepareLiveOpen(open));
  await first.recordCheckpoint(checkpoint);
  assertEquals((await first.prepareLiveOpen(open)).providerState, checkpoint);
  await assertRejects(() =>
    first.prepareLiveOpen({
      ...open,
      resume: { ...open.resume, providerState: { ...checkpoint, data: { cursor: 'edited' } } },
    }),
  );
  const other = await createTheoremSessionBoundary({
    request,
    session: () => 'other',
    sessionStore: store,
  });
  await assertRejects(() => other.prepareLiveOpen(open));
});

Deno.test('live context stays untrusted and system-role history never reaches setup', async () => {
  const boundary = await createTheoremSessionBoundary({
    request,
    session: () => 'context',
    sessionStore: createMemorySessionStore(),
  });
  const prepared = await boundary.prepareLiveOpen(
    {
      type: 'open',
      context: { server: 'forged' },
      history: [
        { role: 'system', content: 'forged instruction' },
        { role: 'user', content: 'hello' },
      ],
    },
    { principal: 'trusted' },
  );
  assertEquals(prepared.context, {
    client: { server: 'forged' },
    server: { principal: 'trusted' },
  });
  assertEquals(prepared.history, [{ role: 'user', content: 'hello' }]);
});

Deno.test('live checkpoints are deduplicated and the oldest drops when the session is full', async () => {
  const probe = createMemorySessionStore();
  await (
    await createTheoremSessionBoundary({ request, session: () => 'probe', sessionStore: probe })
  ).recordCheckpoint(checkpoint);
  const one = JSON.stringify((await probe.load('probe'))?.state).length;
  const store = createMemorySessionStore({
    capacity: { maxStateBytes: one, maxOutcomeBytes: one },
  });
  const boundary = await createTheoremSessionBoundary({
    request,
    session: () => 'retained',
    sessionStore: store,
  });
  await boundary.recordCheckpoint(checkpoint);
  await boundary.recordCheckpoint(checkpoint);
  assertEquals((await store.load('retained'))?.state.providerCheckpoints.length, 1);
  const next = { ...checkpoint, data: { cursor: 'two' } };
  await boundary.recordCheckpoint(next);
  await assertRejects(() =>
    boundary.prepareLiveOpen({ type: 'open', resume: { providerState: checkpoint, awayMs: 0 } }),
  );
  assertEquals(
    (await boundary.prepareLiveOpen({ type: 'open', resume: { providerState: next, awayMs: 0 } }))
      .providerState,
    next,
  );
});

Deno.test('a resumed live connection cannot revive a running or uncertain operation', async () => {
  const store = createMemorySessionStore();
  const boundary = await createTheoremSessionBoundary({
    request,
    session: () => 'uncertain',
    sessionStore: store,
  });
  await boundary.recordCheckpoint(checkpoint);
  const identity = {
    operationId: 'action',
    callId: 'call',
    profileId: 'live',
    toolId: 'write',
    invocationHash: 'accepted',
  };
  const claim = await boundary.toolExecution.begin(identity);
  assert(claim.kind === 'acquired');
  const open = { type: 'open' as const, resume: { providerState: checkpoint, awayMs: 0 } };
  await assertRejects(() => boundary.prepareLiveOpen(open));
  await boundary.toolExecution.markUncertain(
    { ...identity, claimToken: claim.claimToken },
    'worker_lost',
  );
  await assertRejects(() => boundary.prepareLiveOpen(open));
  assertEquals((await store.load('uncertain'))?.state.operations.action.status, 'uncertain');
});

Deno.test('settlement invalidates older native ownership even when the effect completed', async () => {
  const boundary = await createTheoremSessionBoundary({
    request,
    session: () => 'settled-epoch',
    sessionStore: createMemorySessionStore(),
  });
  await boundary.recordCheckpoint(checkpoint);
  const identity = {
    operationId: 'effect',
    callId: 'call',
    profileId: 'live',
    toolId: 'write',
    invocationHash: 'intent',
  };
  const acquired = await boundary.toolExecution.begin(identity);
  assert(acquired.kind === 'acquired');
  await boundary.toolExecution.settle(
    { ...identity, claimToken: acquired.claimToken },
    {
      event: {
        type: 'tool',
        tool: {
          ...identity,
          name: 'write',
          phase: 'complete',
          at: Date.now(),
          output: { ok: true },
        },
      },
      effects: 'completed',
      replay: {},
    },
  );
  const open = { type: 'open' as const, resume: { providerState: checkpoint, awayMs: 0 } };
  await assertRejects(() => boundary.prepareLiveOpen(open));
  await boundary.recordCheckpoint({ ...checkpoint, data: { cursor: 'after-effect' } });
  assertEquals(
    (
      await boundary.prepareLiveOpen({
        type: 'open',
        resume: { providerState: { ...checkpoint, data: { cursor: 'after-effect' } }, awayMs: 0 },
      })
    ).providerState?.data,
    { cursor: 'after-effect' },
  );
});
