import { assertEquals } from '@std/assert';
import {
  clearStudioRunPayloadRecord,
  loadStudioRunPayloadRecord,
  readStudioRunIdFromUrl,
  STUDIO_RUN_INDEX_KEY,
  STUDIO_RUN_PAYLOAD_CAP,
  STUDIO_RUN_PAYLOAD_KEY,
  saveStudioRunPayloadRecord,
  studioRunPayloadKey,
  upsertStudioRunIndex,
} from '../../studio/run-payload-core.ts';

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

Deno.test('studioRunPayloadKey nests under the shared prefix', () => {
  assertEquals(studioRunPayloadKey('abc'), 'theoremjs.studio.run.abc');
});

Deno.test('readStudioRunIdFromUrl reads ?run=', () => {
  assertEquals(readStudioRunIdFromUrl('https://x.example/studio/run/?run=rid-1'), 'rid-1');
  assertEquals(readStudioRunIdFromUrl('/studio/run/?run=rid-2&x=1'), 'rid-2');
  assertEquals(readStudioRunIdFromUrl('/studio/run/'), null);
  assertEquals(readStudioRunIdFromUrl('https://x.example/studio/run/?run=%20'), null);
});

Deno.test('upsertStudioRunIndex keeps newest first and prunes beyond cap', () => {
  const t0 = 1_000;
  let entries = upsertStudioRunIndex([], 'a', t0, 3).entries;
  entries = upsertStudioRunIndex(entries, 'b', t0 + 1, 3).entries;
  entries = upsertStudioRunIndex(entries, 'c', t0 + 2, 3).entries;
  const fourth = upsertStudioRunIndex(entries, 'd', t0 + 3, 3);
  assertEquals(
    fourth.entries.map((e) => e.id),
    ['d', 'c', 'b'],
  );
  assertEquals(fourth.prunedIds, ['a']);
});

Deno.test('upsertStudioRunIndex moves an existing id to newest', () => {
  const base = [
    { id: 'a', savedAt: 1 },
    { id: 'b', savedAt: 2 },
  ];
  const next = upsertStudioRunIndex(base, 'a', 9, 8);
  assertEquals(
    next.entries.map((e) => e.id),
    ['a', 'b'],
  );
  assertEquals(next.entries[0]?.savedAt, 9);
  assertEquals(next.prunedIds, []);
});

Deno.test('save/load/clear round-trip with injectable storage and prune', () => {
  const store = memoryStorage();
  store.setItem(STUDIO_RUN_PAYLOAD_KEY, '{"legacy":true}');

  for (let i = 0; i < STUDIO_RUN_PAYLOAD_CAP + 2; i += 1) {
    saveStudioRunPayloadRecord(
      {
        agentId: `agent-${String(i)}`,
        profile: { id: 'p' },
        customTools: [],
      },
      `run-${String(i)}`,
      store,
    );
  }

  assertEquals(store.getItem(STUDIO_RUN_PAYLOAD_KEY), null);
  assertEquals(loadStudioRunPayloadRecord('run-0', store), null);
  assertEquals(loadStudioRunPayloadRecord('run-1', store), null);
  const newest = loadStudioRunPayloadRecord(`run-${String(STUDIO_RUN_PAYLOAD_CAP + 1)}`, store);
  assertEquals(newest?.agentId, `agent-${String(STUDIO_RUN_PAYLOAD_CAP + 1)}`);
  assertEquals(newest?.runId, `run-${String(STUDIO_RUN_PAYLOAD_CAP + 1)}`);
  assertEquals(newest?.version, 1);

  const indexRaw = store.getItem(STUDIO_RUN_INDEX_KEY);
  assertEquals(typeof indexRaw, 'string');
  if (typeof indexRaw !== 'string') return;
  const index = JSON.parse(indexRaw) as { entries: { id: string }[] };
  assertEquals(index.entries.length, STUDIO_RUN_PAYLOAD_CAP);

  clearStudioRunPayloadRecord(`run-${String(STUDIO_RUN_PAYLOAD_CAP + 1)}`, store);
  assertEquals(
    loadStudioRunPayloadRecord(`run-${String(STUDIO_RUN_PAYLOAD_CAP + 1)}`, store),
    null,
  );
});
