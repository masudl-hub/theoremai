import { assert, assertEquals } from '@std/assert';
import { registerTool, type TurnEvent, z } from '../../mod.ts';
import { createTheoremHostHandler } from '../../react/src/server/mod.ts';
import { sqliteSessionStore } from '../fixtures/sqlite-session-store.ts';

for (const phase of [
  'before_ready',
  'ready',
  'running',
  'in_flight',
  'effect',
  'settled',
] as const) {
  Deno.test(`a killed worker at ${phase} retains authoritative recovery without duplicate effects`, async () => {
    const directory = await Deno.makeTempDir();
    const path = `${directory}/authority.sqlite`;
    const name = `process_loss_${phase}`;
    let effects = 0;
    let finishResponse = () => {};
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, () => {
      effects++;
      if (phase === 'in_flight')
        return new Response(
          new ReadableStream({
            start(controller) {
              finishResponse = () => controller.close();
              controller.enqueue(new TextEncoder().encode('pending'));
            },
            cancel() {
              finishResponse = () => {};
            },
          }),
        );
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
      handler: async () => {
        await (await fetch(endpoint, { method: 'POST' })).text();
        return { ok: true };
      },
    });
    const store = sqliteSessionStore(path);
    const make = () =>
      createTheoremHostHandler({
        profile: { id: name, type: 'host', tools: { allow: [name] } },
        session: () => name,
        sessionStore: store,
      });
    const post = async (handler: ReturnType<typeof make>, route: string, body: unknown) => {
      const response = await handler(
        new Request(`https://crash.test/${route}`, {
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
    };
    let child: Deno.ChildProcess | undefined;
    try {
      const gate = (await post(make(), 'call', { name, input: {} })).events.find(
        (event) => event.type === 'tool' && event.tool.phase === 'gate',
      );
      assert(gate?.type === 'tool' && gate.tool.operationId);
      const answer = {
        gateId: gate.tool.callId,
        operationId: gate.tool.operationId,
        decision: 'approve',
      };
      child = new Deno.Command(Deno.execPath(), {
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
          phase,
          endpoint,
          JSON.stringify(answer),
          name,
        ],
        stdout: 'piped',
        stderr: 'inherit',
      }).spawn();
      const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
      let text = '';
      const timer = setTimeout(() => child?.kill('SIGKILL'), 30_000);
      try {
        while (!text.includes('CRASH_BARRIER')) {
          const row = await reader.read();
          assert(!row.done, 'worker exited before the barrier');
          text += row.value;
        }
      } finally {
        clearTimeout(timer);
        reader.releaseLock();
      }
      child.kill('SIGKILL');
      await child.status;
      const stored = (await store.load(name))?.state.operations[gate.tool.operationId];
      if (phase === 'before_ready') {
        assertEquals(stored, undefined);
        assert((await store.load(name))?.state.gates[gate.tool.operationId]);
      } else {
        assert(stored);
        assertEquals(
          stored.status,
          phase === 'effect' || phase === 'in_flight' ? 'running' : phase,
        );
      }
      assertEquals(
        effects,
        phase === 'effect' || phase === 'settled' || phase === 'in_flight' ? 1 : 0,
      );
      const replay = await post(make(), 'invoke', answer);
      if (phase === 'running' || phase === 'effect' || phase === 'in_flight') {
        assertEquals(replay.status, 503);
        assertEquals(effects, phase === 'effect' || phase === 'in_flight' ? 1 : 0);
      } else {
        assertEquals(replay.status, 200);
        assert(
          replay.events.some((event) => event.type === 'tool' && event.tool.phase === 'complete'),
        );
        assertEquals(effects, 1);
      }
    } finally {
      if (child) {
        try {
          child.kill('SIGKILL');
        } catch {
          await child.status;
        }
        await child.status;
        await child.stdout.cancel().catch(() => {});
      }
      finishResponse();
      await server.shutdown();
      await Deno.remove(directory, { recursive: true });
    }
  });
}
