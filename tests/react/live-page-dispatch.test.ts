import { assert, assertEquals, assertRejects } from '@std/assert';
import { createKernelScope, defineProvider, googleAdapter, type TurnEvent, z } from '../../mod.ts';
import {
  createMemorySessionStore,
  createTheoremSessionBoundary,
} from '../../react/src/server/mod.ts';
import { MockLiveWebSocket } from '../fixtures/live-socket.ts';
import { HOST_BINDINGS } from '../fixtures/models.ts';

Deno.test('native live approval dispatch uses saved prepared input and settles one authoritative result', async () => {
  const scope = createKernelScope();
  scope.providers.register(
    defineProvider({ id: 'google', connection: {}, adapter: googleAdapter() }),
  );
  scope.tools.register({
    type: 'function',
    name: 'page_write',
    description: 'Write on the page',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    answeredBy: 'page',
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
    preTool: () => ({ mutate: { input: { id: 'prepared' } }, confirm: true }),
  });
  scope.profiles.register({
    id: 'live_page',
    type: 'live',
    identity: { handle: 'Live' },
    models: { default: { ...HOST_BINDINGS.gemini31FlashLive, keySlot: 'key' } },
    live: { voice: 'Aoede', ingress: { text: true } },
    tools: { allow: ['page_write'] },
  });
  const store = createMemorySessionStore();
  const boundary = await createTheoremSessionBoundary({
    request: new Request('https://live.test'),
    session: () => 'owner',
    sessionStore: store,
  });
  const socket = new MockLiveWebSocket();
  const session = await scope.runSession(
    { profile: 'live_page' },
    {
      vault: { key: 'fixture' },
      execution: boundary.toolExecution,
      pageExecution: boundary.pageExecution,
      openWebSocket: () => {
        queueMicrotask(() => socket.open());
        return Promise.resolve(socket as unknown as WebSocket);
      },
    },
  );
  let called = () => {};
  const ready = new Promise<void>((resolve) => {
    called = resolve;
  });
  let effects = 0;
  const events: TurnEvent[] = [];
  const drain = (async () => {
    for await (const event of session.events()) {
      events.push(event);
      if (event.type !== 'tool') continue;
      if (event.tool.phase === undefined) called();
      if (event.tool.phase !== 'dispatch') continue;
      const grant = event.tool;
      assert(grant.operationId);
      assertEquals(grant.arguments, { id: 'prepared' });
      const operation = (await store.load('owner'))?.state.operations[grant.operationId];
      assert(operation?.status === 'running');
      assertEquals(operation.invocation?.preparedInput, { id: 'prepared' });
      effects++;
      const result = {
        callId: grant.callId,
        operationId: grant.operationId,
        grantId: grant.grantId,
        page: { output: { ok: true } },
      };
      await boundary.answerPageResult(result);
      await boundary.answerPageResult(result);
    }
  })();
  try {
    socket.deliver({
      toolCall: { functionCalls: [{ id: 'call', name: 'page_write', args: { id: 'original' } }] },
    });
    await ready;
    const held = await session.executeTool({ callId: 'call' });
    assertEquals(held.gated?.kind, 'confirmation');
    assertEquals(held.gated?.preparedArguments, { id: 'prepared' });
    const completed = await session.executeTool({ callId: 'call', decision: 'approve' });
    assertEquals(completed.outputRaw, { ok: true });
    assertEquals(effects, 1);
    await assertRejects(() => session.executeTool({ callId: 'call' }));
    const responses = socket.sent.flatMap(
      (frame) => JSON.parse(frame).toolResponse?.functionResponses ?? [],
    );
    assertEquals(responses.length, 1);
    const operation = Object.values((await store.load('owner'))?.state.operations ?? {})[0];
    assertEquals(operation.status, 'settled');
  } finally {
    socket.close();
    await session.close();
    await drain;
  }
  assert(events.some((event) => event.type === 'tool' && event.tool.phase === 'complete'));
});
