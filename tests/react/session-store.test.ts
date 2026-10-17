import { assert, assertEquals, assertNotEquals, assertThrows } from '@std/assert';
import { TheoremError } from '../../mod.ts';
import {
  createMemorySessionStore,
  emptySessionState,
  type PendingToolGate,
  pruneGates,
  theoremSessionStateSchema,
} from '../../react/src/server/session-store.ts';
import { sqliteSessionStore } from '../fixtures/sqlite-session-store.ts';

function gate(createdAt: number): PendingToolGate {
  return {
    profileId: 'profile',
    operationId: 'call',
    callId: 'call',
    name: 'issue_refund',
    arguments: {},
    gate: { kind: 'permission', permission: 'always_confirm' },
    promoted: [],
    turnInput: { text: 'refund order 42' },
    createdAt,
  };
}

Deno.test('pruneGates keeps every gate younger than the ttl and drops the rest', () => {
  const now = Date.now();
  const waiting = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [`gate_${i}`, gate(now - i)]),
  );
  const kept = pruneGates({ ...waiting, stale: gate(now - 5_000) }, now, 2_000);
  assertEquals(Object.keys(kept).length, 100);
  assertEquals('stale' in kept, false);
});

Deno.test('absolute gate expiry survives a handler TTL change', () => {
  const waiting = { ...gate(100), expiresAt: 200 };
  assertEquals(Object.keys(pruneGates({ waiting }, 199, 1)), ['waiting']);
  assertEquals(pruneGates({ waiting }, 200, 10000), {});
});

Deno.test('memory capacity can evict an absolutely expired gate but preserves unresolved operations', async () => {
  const store = createMemorySessionStore({ maxSessions: 1 });
  const state = emptySessionState();
  state.gates.call = { ...gate(0), expiresAt: 1 };
  assert((await store.compareAndSwap('expired', null, state)).written);
  assert((await store.compareAndSwap('replacement', null, emptySessionState())).written);
  assertEquals(await store.load('expired'), undefined);
});

Deno.test('memory store rejects authority beyond its finite limits without altering saved state', async () => {
  const store = createMemorySessionStore({ sessionLimits: { maxGates: 1 } });
  const first = emptySessionState();
  first.gates.first = { ...gate(Date.now()), operationId: 'first' };
  const written = await store.compareAndSwap('bounded', null, first);
  assert(written.written);
  const second = structuredClone(first);
  second.gates.second = { ...gate(Date.now()), operationId: 'second' };
  assertThrows(() => store.compareAndSwap('bounded', written.revision, second), TheoremError);
  assertEquals((await store.load('bounded'))?.state, first);
});

for (const backend of ['memory', 'sqlite'] as const) {
  Deno.test(`${backend} session store admits one creation and one replacement per revision`, async () => {
    const directory = backend === 'sqlite' ? await Deno.makeTempDir() : undefined;
    try {
      const stores =
        backend === 'sqlite'
          ? [
              sqliteSessionStore(`${directory}/state.db`),
              sqliteSessionStore(`${directory}/state.db`),
            ]
          : Array(2).fill(createMemorySessionStore());
      const next = emptySessionState();
      const created = await Promise.all(
        stores.map((store) => store.compareAndSwap('same', null, next)),
      );
      assertEquals(created.filter((result) => result.written).length, 1);
      const snapshot = await stores[0].load('same');
      assert(snapshot);
      const replaced = await Promise.all(
        stores.map((store, index) =>
          store.compareAndSwap('same', snapshot.revision, {
            ...next,
            permissions: [`tool-${index}`],
          }),
        ),
      );
      assertEquals(replaced.filter((result) => result.written).length, 1);
      const latest = await stores[1].load('same');
      assert(latest);
      assertNotEquals(latest.revision, snapshot.revision);
      assertEquals(await stores[0].compareAndSwap('same', snapshot.revision, next), {
        written: false,
      });
      latest.state.permissions.push('forged');
      assertEquals((await stores[1].load('same'))?.state.permissions.length, 1);
      next.permissions.push('also-forged');
      assertEquals((await stores[0].load('same'))?.state.permissions.length, 1);
    } finally {
      if (directory) await Deno.remove(directory, { recursive: true });
    }
  });
}

Deno.test('memory session store preserves pending gates and refuses capacity overflow', async () => {
  const store = createMemorySessionStore({ ttlMs: 1, maxSessions: 1 });
  const written = await store.compareAndSwap('pending', null, {
    ...emptySessionState(),
    gates: { call: gate(0) },
  });
  assert(written.written);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert((await store.load('pending'))?.state.gates.call);
  assertThrows(() => store.compareAndSwap('other', null, emptySessionState()), TheoremError);
  assertEquals((await store.load('pending'))?.revision, written.revision);
});

Deno.test('memory session store issues a fresh revision after idle expiration', async () => {
  const store = createMemorySessionStore({ ttlMs: 1 });
  const first = await store.compareAndSwap('idle', null, emptySessionState());
  assert(first.written);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals(await store.compareAndSwap('idle', first.revision, emptySessionState()), {
    written: false,
  });
  const recreated = await store.compareAndSwap('idle', null, emptySessionState());
  assert(recreated.written);
  assertNotEquals(first.revision, recreated.revision);
});

Deno.test('session state rejects unsupported versions and overlapping authority records', () => {
  assertEquals(
    theoremSessionStateSchema.safeParse({ ...emptySessionState(), version: 2 }).success,
    false,
  );
  assertEquals(
    theoremSessionStateSchema.safeParse({ ...emptySessionState(), version: 1 }).success,
    false,
  );
  assertEquals(
    theoremSessionStateSchema.safeParse({ ...emptySessionState(), version: undefined }).success,
    false,
  );
  assertEquals(
    theoremSessionStateSchema.safeParse({
      ...emptySessionState(),
      gates: { call: gate(0) },
      operations: {
        call: {
          status: 'running',
          operationId: 'call',
          callId: 'call',
          profileId: 'profile',
          toolId: 'issue_refund',
          invocationHash: 'hash',
          claimToken: 'worker',
          startedAt: 0,
        },
      },
    }).success,
    false,
  );
});

Deno.test('memory session store rejects invalid retention limits at construction', () => {
  for (const options of [
    { ttlMs: 0 },
    { ttlMs: Number.NaN },
    { maxSessions: 0 },
    { maxSessions: 1.5 },
  ]) {
    assertThrows(() => createMemorySessionStore(options), TheoremError);
  }
});

Deno.test('stored sign-in metadata must match the issued gate kind', () => {
  const state = emptySessionState();
  const auth = { slot: 'service', authType: 'bearer' as const, service: 'Service' };
  for (const malformed of [
    { ...gate(0), gate: { kind: 'auth' as const } },
    { ...gate(0), gate: { kind: 'permission' as const, auth } },
  ]) {
    assertEquals(
      theoremSessionStateSchema.safeParse({ ...state, gates: { call: malformed } }).success,
      false,
    );
  }
  assertEquals(
    theoremSessionStateSchema.safeParse({
      ...state,
      gates: { call: { ...gate(0), gate: { kind: 'auth', auth } } },
    }).success,
    true,
  );
});
