import { assertEquals } from '@std/assert';
import {
  clearPlaygroundRunPayloadRecord,
  loadPlaygroundRunPayloadRecord,
  PLAYGROUND_RUN_INDEX_KEY,
  PLAYGROUND_RUN_PAYLOAD_CAP,
  PLAYGROUND_RUN_PAYLOAD_KEY,
  playgroundRunPayloadKey,
  readPlaygroundRunIdFromUrl,
  savePlaygroundRunPayloadRecord,
  upsertPlaygroundRunIndex,
} from '../../react/src/client/run-payload-core.ts';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      const value = map.get(key);
      return value === undefined ? null : value;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

Deno.test('playgroundRunPayloadKey nests under the shared prefix', () => {
  assertEquals(playgroundRunPayloadKey('abc'), 'theorum.playground.run.abc');
});

Deno.test('readPlaygroundRunIdFromUrl reads ?run=', () => {
  assertEquals(readPlaygroundRunIdFromUrl('https://x.example/playground/run/?run=rid-1'), 'rid-1');
  assertEquals(readPlaygroundRunIdFromUrl('/playground/run/?run=rid-2&x=1'), 'rid-2');
  assertEquals(readPlaygroundRunIdFromUrl('/playground/run/'), null);
  assertEquals(readPlaygroundRunIdFromUrl('https://x.example/playground/run/?run=%20'), null);
});

Deno.test('upsertPlaygroundRunIndex keeps newest first and prunes beyond cap', () => {
  const t0 = 1_000;
  let entries = upsertPlaygroundRunIndex([], 'a', t0, 3).entries;
  entries = upsertPlaygroundRunIndex(entries, 'b', t0 + 1, 3).entries;
  entries = upsertPlaygroundRunIndex(entries, 'c', t0 + 2, 3).entries;
  const fourth = upsertPlaygroundRunIndex(entries, 'd', t0 + 3, 3);
  assertEquals(
    fourth.entries.map((e) => e.id),
    ['d', 'c', 'b'],
  );
  assertEquals(fourth.prunedIds, ['a']);
});

Deno.test('upsertPlaygroundRunIndex moves an existing id to newest', () => {
  const base = [
    { id: 'a', savedAt: 1 },
    { id: 'b', savedAt: 2 },
  ];
  const next = upsertPlaygroundRunIndex(base, 'a', 9, 8);
  assertEquals(
    next.entries.map((e) => e.id),
    ['a', 'b'],
  );
  assertEquals(next.entries[0]?.savedAt, 9);
  assertEquals(next.prunedIds, []);
});

Deno.test('save/load/clear round-trip with injectable storage and prune', () => {
  const store = memoryStorage();
  store.setItem(PLAYGROUND_RUN_PAYLOAD_KEY, '{"legacy":true}');

  for (let i = 0; i < PLAYGROUND_RUN_PAYLOAD_CAP + 2; i += 1) {
    savePlaygroundRunPayloadRecord(
      {
        agentId: `agent-${String(i)}`,
        profile: { id: 'p' },
        customTools: [],
      },
      `run-${String(i)}`,
      store,
    );
  }

  assertEquals(store.getItem(PLAYGROUND_RUN_PAYLOAD_KEY), null);
  assertEquals(loadPlaygroundRunPayloadRecord('run-0', store), null);
  assertEquals(loadPlaygroundRunPayloadRecord('run-1', store), null);
  const newest = loadPlaygroundRunPayloadRecord(
    `run-${String(PLAYGROUND_RUN_PAYLOAD_CAP + 1)}`,
    store,
  );
  assertEquals(newest?.agentId, `agent-${String(PLAYGROUND_RUN_PAYLOAD_CAP + 1)}`);
  assertEquals(newest?.runId, `run-${String(PLAYGROUND_RUN_PAYLOAD_CAP + 1)}`);
  assertEquals(newest?.version, 1);

  const indexRaw = store.getItem(PLAYGROUND_RUN_INDEX_KEY);
  assertEquals(typeof indexRaw, 'string');
  if (typeof indexRaw !== 'string') return;
  const index = JSON.parse(indexRaw) as { entries: { id: string }[] };
  assertEquals(index.entries.length, PLAYGROUND_RUN_PAYLOAD_CAP);

  clearPlaygroundRunPayloadRecord(`run-${String(PLAYGROUND_RUN_PAYLOAD_CAP + 1)}`, store);
  assertEquals(
    loadPlaygroundRunPayloadRecord(`run-${String(PLAYGROUND_RUN_PAYLOAD_CAP + 1)}`, store),
    null,
  );
});
