import { assert, assertEquals } from '@std/assert';
import { registerTool, type TurnEvent, z } from '../../mod.ts';
import { createHostTransport } from '../../react/src/client/host-transport.ts';
import { withPageToolDispatch } from '../../react/src/client/page-dispatch.ts';
import { createMemorySessionStore, createTheoremHostHandler } from '../../react/src/server/mod.ts';

for (const permission of ['auto', 'always_confirm', 'confirmation'] as const) {
  Deno.test(`browser ${permission} dispatch carries final prepared arguments after its durable claim`, async () => {
    const name = `claimed_browser_effect_${permission}`;
    registerTool({
      type: 'function',
      name,
      description: 'Act on the page',
      category: 'test',
      access: 'read-write',
      paths: ['*'],
      loadTier: 'T0',
      permission: permission === 'confirmation' ? 'auto' : permission,
      answeredBy: 'page',
      input: z.object({ id: z.string() }),
      output: z.object({ ok: z.boolean() }),
      preTool: () => ({
        mutate: { input: { id: 'final' } },
        ...(permission === 'confirmation' ? { confirm: true } : {}),
      }),
    });
    const store = createMemorySessionStore();
    const handler = createTheoremHostHandler({
      profile: { type: 'host', id: name, tools: { allow: [name] } },
      session: (request) => request.headers.get('x-session') ?? undefined,
      sessionStore: store,
    });
    const post = (route: string, body: unknown, session = 'owner') =>
      handler(
        new Request(`https://page.test/${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-session': session },
          body: JSON.stringify(body),
        }),
      );
    let response = await post('call', { name, input: { id: 'proposed' } });
    if (permission !== 'auto') {
      const events = (await response.text())
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as TurnEvent);
      const gate = events.find((event) => event.type === 'tool' && event.tool.phase === 'gate');
      assert(gate?.type === 'tool');
      response = await post('invoke', {
        gateId: gate.tool.callId,
        operationId: gate.tool.operationId,
        decision: 'approve',
      });
    }
    assert(response.body);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = '';
    let effects = 0;
    let grant: Extract<TurnEvent, { type: 'tool' }>['tool'] | undefined;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      buffered += next.value;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const event = JSON.parse(line) as TurnEvent;
        if (event.type !== 'tool' || event.tool.phase !== 'dispatch') continue;
        grant = event.tool;
        assert(grant.operationId);
        const operation = (await store.load('owner'))?.state.operations[grant.operationId];
        assert(operation?.status === 'running');
        assertEquals(operation.pageGrant?.grantId, grant.grantId);
        assertEquals(grant.arguments, { id: 'final' });
        const result = {
          callId: grant.callId,
          operationId: grant.operationId,
          grantId: grant.grantId,
          page: { output: { ok: true } },
        };
        assertEquals((await post('page-result', result, 'other')).status, 503);
        assertEquals((await post('page-result', { ...result, grantId: 'forged' })).status, 503);
        effects++;
        assertEquals((await post('page-result', result)).status, 200);
        assertEquals((await post('page-result', result)).status, 200);
      }
    }
    assert(grant?.phase === 'dispatch');
    const operation = (await store.load('owner'))?.state.operations[grant.operationId ?? ''];
    assert(operation?.status === 'settled');
    assertEquals(operation.outcome.effects, 'completed');
    assertEquals(effects, 1);
    const replay = await post('invoke', {
      gateId: grant.callId,
      operationId: grant.operationId,
      decision: 'approve',
    });
    const events = (await replay.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TurnEvent);
    assert(events.every((event) => event.type !== 'tool' || event.tool.phase !== 'dispatch'));
  });
}

Deno.test('host transport dispatches prepared page input and settled replay cannot call the page twice', async () => {
  const name = 'host_transport_claimed_page';
  registerTool({
    type: 'function',
    name,
    description: 'Act on the page',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    answeredBy: 'page',
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
    preTool: () => ({ mutate: { input: { id: 'prepared' } } }),
  });
  const store = createMemorySessionStore();
  const handler = createTheoremHostHandler({
    profile: { type: 'host', id: name, tools: { allow: [name] } },
    session: () => 'host-transport-owner',
    sessionStore: store,
  });
  let effects = 0;
  const transport = withPageToolDispatch(
    createHostTransport({
      endpoint: 'https://page.test/host',
      fetch: (url, init) => handler(new Request(url, init)),
    }),
    {
      [name]: async (input, reference) => {
        assertEquals(input, { id: 'prepared' });
        const saved = await store.load('host-transport-owner');
        assert(saved?.state.operations[reference.operationId]?.status === 'running');
        effects++;
        return { output: { ok: true } };
      },
    },
  );
  const events: TurnEvent[] = [];
  const sink = (event: Parameters<Parameters<typeof transport.call>[1]>[0]) => {
    assert(event.type !== 'unsupported' && event.type !== 'malformed');
    events.push(event);
  };
  await transport.call({ name, input: { id: 'proposed' } }, sink);
  const dispatch = events.find((event) => event.type === 'tool' && event.tool.phase === 'dispatch');
  assert(dispatch?.type === 'tool' && dispatch.tool.operationId);
  assert(events.some((event) => event.type === 'tool' && event.tool.phase === 'complete'));
  await transport.invoke(
    { gateId: dispatch.tool.callId, operationId: dispatch.tool.operationId, decision: 'approve' },
    sink,
  );
  assertEquals(effects, 1);
});
