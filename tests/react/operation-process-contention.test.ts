import { assert, assertEquals } from '@std/assert';
import { registerTool, type TurnEvent, z } from '../../mod.ts';
import { createTheoremHostHandler } from '../../react/src/server/mod.ts';
import { sqliteSessionStore } from '../fixtures/sqlite-session-store.ts';

Deno.test('two independent kernel workers approve one action through atomic SQLite authority', async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/authority.sqlite`;
  const name = 'two_worker_effect';
  let effects = 0;
  let waiting = 0;
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
    if (new URL(request.url).pathname === '/ready') {
      if (++waiting === 2) release();
      await ready;
      return new Response('ready');
    }
    effects++;
    return Response.json({ ok: true });
  });
  const endpoint = `http://127.0.0.1:${server.addr.port}`;
  registerTool({
    type: 'function',
    name,
    description: 'Count an external effect',
    category: 'test',
    access: 'read-write',
    permission: 'always_confirm',
    loadTier: 'T0',
    paths: ['*'],
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    handler: () => {
      throw new Error('The parent only issues the gate');
    },
  });
  const store = sqliteSessionStore(path);
  const handler = createTheoremHostHandler({
    profile: { id: name, type: 'host', tools: { allow: [name] } },
    session: () => name,
    sessionStore: store,
  });
  const children: Deno.ChildProcess[] = [];
  const timer = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    release();
  }, 30_000);
  try {
    const response = await handler(
      new Request('https://race.test/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, input: {} }),
      }),
    );
    const events = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TurnEvent);
    const gate = events.find((event) => event.type === 'tool' && event.tool.phase === 'gate');
    assert(gate?.type === 'tool' && gate.tool.operationId);
    const answer = JSON.stringify({
      gateId: gate.tool.callId,
      operationId: gate.tool.operationId,
      decision: 'approve',
    });
    for (let index = 0; index < 2; index++) {
      children.push(
        new Deno.Command(Deno.execPath(), {
          args: [
            'run',
            '--cached-only',
            '--allow-read',
            '--allow-write',
            '--allow-env',
            '--allow-net',
            '--allow-run=node',
            new URL('../fixtures/operation-crash-worker.ts', import.meta.url).pathname,
            path,
            'race',
            endpoint,
            answer,
            name,
          ],
          stdout: 'piped',
          stderr: 'piped',
        }).spawn(),
      );
    }
    const outputs = await Promise.all(children.map((child) => child.output()));
    assert(
      outputs.every((output) => output.success),
      outputs.map((output) => new TextDecoder().decode(output.stderr)).join('\n'),
    );
    const replies = outputs.map(
      (output) =>
        JSON.parse(new TextDecoder().decode(output.stdout)) as { status: number; text: string },
    );
    assert(
      replies.some((reply) => reply.status === 200 && reply.text.includes('"phase":"complete"')),
    );
    assertEquals(waiting, 2);
    assertEquals(effects, 1);
    const settled = (await store.load(name))?.state.operations[gate.tool.operationId];
    assertEquals(settled?.status, 'settled');
  } finally {
    clearTimeout(timer);
    release();
    for (const child of children) {
      await child.status;
    }
    await server.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
});
