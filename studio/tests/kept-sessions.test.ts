import { assert, assertEquals } from '@std/assert';
import type { TheoremSessionState } from '@theoremjs/web/server';
import { createKeptSessions, keptSessionStore } from '../server/kept-sessions.ts';

const STATE: TheoremSessionState = {
  version: 3,
  operations: {},
  permissions: [],
  gates: {},
  providerCheckpoints: [],
};
/** A session with a detached call for each of `ids`. */
const running = (...ids: string[]): TheoremSessionState => ({
  ...STATE,
  operations: Object.fromEntries(
    ids.map((operationId) => [
      operationId,
      {
        status: 'background' as const,
        operationId,
        callId: operationId,
        profileId: 'desk',
        toolId: 'slow_report',
        invocationHash: 'hash',
        claimToken: 'claim',
        startedAt: 1,
        detachedAt: 1,
        reply: {
          event: {
            type: 'tool' as const,
            tool: {
              name: 'slow_report',
              callId: operationId,
              at: 1,
              phase: 'background' as const,
              readBack: 'started',
            },
          },
          replay: { modelResult: { finding: 'started' } },
        },
      },
    ]),
  ),
});

/** A load's store, its requests answered by `kept` with no server between. */
function loadOf(kept: ReturnType<typeof createKeptSessions>, load: string, scope = 'files') {
  return keptSessionStore({ url: 'http://kept/', token: kept.token, load, scope }, 'desk');
}
function withAnswers(kept: ReturnType<typeof createKeptSessions>) {
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => kept.answer(new Request(input, init));
  return {
    [Symbol.dispose]: () => {
      globalThis.fetch = real;
    },
  };
}

Deno.test('a session a load wrote is read by the load after it, and only in its scope', async () => {
  const kept = createKeptSessions();
  using _ = withAnswers(kept);
  assert((await loadOf(kept, 'a').compareAndSwap('s', null, STATE)).written);
  assertEquals((await loadOf(kept, 'b').load('s'))?.state, STATE);
  assertEquals(await loadOf(kept, 'b', 'edited').load('s'), undefined);
});

Deno.test('a write from a stale revision is not taken', async () => {
  const kept = createKeptSessions();
  using _ = withAnswers(kept);
  const store = loadOf(kept, 'a');
  await store.compareAndSwap('s', null, STATE);
  assertEquals(await store.compareAndSwap('s', 'old', STATE), { written: false });
});

Deno.test('a request without the token is refused', async () => {
  const kept = createKeptSessions();
  const asked = new Request('http://kept/', { method: 'POST', body: '{"sessionId":"s"}' });
  assertEquals((await kept.answer(asked)).status, 401);
});

Deno.test('a load is kept until the calls it detached end, whoever writes after it', async () => {
  const kept = createKeptSessions();
  using _ = withAnswers(kept);
  const started = loadOf(kept, 'a');
  assertEquals(kept.callsEnd('a'), undefined);
  await started.compareAndSwap('s', null, running('op'));
  const ended = kept.callsEnd('a');
  assert(ended);
  const snapshot = await started.load('s');
  // why: the load that took over writes the session while the call runs on in the first.
  const written = await loadOf(kept, 'b').compareAndSwap('s', snapshot?.revision ?? null, {
    ...running('op'),
    permissions: ['x'],
  });
  assertEquals(kept.callsEnd('b'), undefined);
  assert(written.written);
  await started.compareAndSwap('s', written.revision, STATE);
  await ended;
  assertEquals(kept.callsEnd('a'), undefined);
});

Deno.test('a load that exits leaves its calls with no known end', async () => {
  const kept = createKeptSessions();
  using _ = withAnswers(kept);
  const store = loadOf(kept, 'a');
  await store.compareAndSwap('s', null, running('op'));
  const ended = kept.callsEnd('a');
  await kept.loadEnded('a');
  await ended;
  assertEquals((await store.load('s'))?.state.operations, {});
});
