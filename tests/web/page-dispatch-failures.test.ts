import { assert, assertEquals, assertRejects } from '@std/assert';
import type { ToolOperationIdentity } from '../../mod.ts';
import {
  createMemoryPageToolBroker,
  sessionPageDispatch,
} from '../../web/src/server/page-dispatch.ts';
import { sessionStateStore } from '../../web/src/server/session-authority.ts';
import { createMemorySessionStore } from '../../web/src/server/session-store.ts';
import { sessionToolCoordinator } from '../../web/src/server/tool-operations.ts';

async function authority() {
  const store = sessionStateStore(createMemorySessionStore(), 30 * 60_000, 86_400_000);
  const execution = sessionToolCoordinator(store, 'owner');
  const identity: ToolOperationIdentity = {
    operationId: 'operation',
    callId: 'call',
    profileId: 'profile',
    toolId: 'tool',
    invocationHash: 'intent',
    invocation: { accepted: { input: {} }, preparedInput: {} },
  };
  const acquired = await execution.begin(identity);
  assert(acquired.kind === 'acquired');
  return { store, execution, claim: { ...identity, claimToken: acquired.claimToken } };
}

Deno.test('expired and cancelled grants cannot reopen browser execution', async () => {
  for (const abort of [false, true]) {
    const { store, claim, execution } = await authority();
    const controller = new AbortController();
    const broker = createMemoryPageToolBroker(1);
    // why: A short window the grant reliably outlives under a loaded suite; the abort case never waits on it.
    const page = sessionPageDispatch(store, 'owner', broker, abort ? 120_000 : 500);
    const grant = await page.execution.dispatch(claim, controller.signal);
    if (abort) controller.abort();
    assertEquals(await grant.result, { timedOut: true });
    await execution.markUncertain(claim, 'worker_lost');
    await assertRejects(() =>
      page.answer({
        callId: claim.callId,
        operationId: claim.operationId,
        grantId: grant.grantId,
        page: { output: true },
      }),
    );
    await assertRejects(() => page.execution.dispatch(claim));
    assertEquals((await store.read('owner')).operations.operation.status, 'uncertain');
    const free = broker.reserve('other', 'new');
    free.cancel();
    await free.result;
  }
});

Deno.test('a result delivery failure retains its receipt and cannot issue another grant', async () => {
  const { store, claim } = await authority();
  const memory = createMemoryPageToolBroker();
  const controller = new AbortController();
  const page = sessionPageDispatch(
    store,
    'owner',
    {
      reserve: memory.reserve,
      deliver: () => Promise.reject(new Error('lost worker')),
    },
    120_000,
  );
  const grant = await page.execution.dispatch(claim, controller.signal);
  await assertRejects(
    () =>
      page.answer({
        callId: claim.callId,
        operationId: claim.operationId,
        grantId: grant.grantId,
        page: { output: true },
      }),
    Error,
    'lost worker',
  );
  const record = (await store.read('owner')).operations.operation;
  assert(record.status === 'running');
  assert(record.pageGrant?.resultHash);
  await assertRejects(() => page.execution.dispatch(claim));
  controller.abort();
  assertEquals(await grant.result, { timedOut: true });
});

Deno.test('failed grant persistence emits no usable grant and releases its broker reservation', async () => {
  const { store, claim } = await authority();
  const broker = createMemoryPageToolBroker(1);
  const page = sessionPageDispatch(
    { ...store, mutate: () => Promise.reject(new Error('storage unavailable')) },
    'owner',
    broker,
  );
  await assertRejects(() => page.execution.dispatch(claim));
  const replacement = broker.reserve('other', 'replacement');
  replacement.cancel();
  await replacement.result;
  const record = (await store.read('owner')).operations.operation;
  assert(record.status === 'running');
  assertEquals(record.pageGrant, undefined);
});

Deno.test('an uncooperative broker cannot extend the dispatch result deadline', async () => {
  const { store, claim } = await authority();
  const page = sessionPageDispatch(
    store,
    'owner',
    {
      reserve: () => ({ result: new Promise(() => {}), cancel() {} }),
      deliver: () => Promise.resolve(),
    },
    500,
  );
  const grant = await page.execution.dispatch(claim);
  assertEquals(await grant.result, { timedOut: true });
});
