import { assertEquals } from '@std/assert';
import {
  clearStaleStudioRuns,
  compileStudio,
  createExampleDraft,
  keptStudioRunIds,
  type StudioRunPayload,
  saveStudioRunPayload,
  studioRunDefines,
  studioRunPayloadKey,
} from '../../studio/mod.ts';

function exampleRun(): StudioRunPayload {
  const result = compileStudio(createExampleDraft());
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result;
}

Deno.test('a run this package compiled defines', () => {
  assertEquals(studioRunDefines(exampleRun()), true);
});

Deno.test('a run kept with a setting this package no longer takes does not define', () => {
  const run = exampleRun();
  const kept = {
    ...run,
    profile: {
      ...run.profile,
      guardrails: { ...run.profile.guardrails, blockedReply: { action: 'refuse' } },
    },
  } as unknown as StudioRunPayload;
  assertEquals(studioRunDefines(kept), false);
});

Deno.test('a run whose called agent no longer defines does not define', () => {
  const run = exampleRun();
  const kept = {
    ...run,
    dependencies: [
      {
        profile: {
          ...run.profile,
          id: 'kept.agent',
          guardrails: { blockedReply: { action: 'refuse' } },
        },
        customTools: [],
      },
    ],
  } as unknown as StudioRunPayload;
  assertEquals(studioRunDefines(kept), false);
});

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
      return map.get(key) ?? null;
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

Deno.test('clearing stale runs keeps only the runs this package defines', () => {
  const store = memoryStorage();
  const run = exampleRun();
  saveStudioRunPayload(run, 'current', store);
  saveStudioRunPayload(
    {
      ...run,
      profile: { ...run.profile, guardrails: { egress: { checks: true } } },
    } as unknown as StudioRunPayload,
    'old-shape',
    store,
  );
  store.setItem(studioRunPayloadKey('unindexed'), '{"agentId":"x"}');
  store.setItem(studioRunPayloadKey('unreadable'), 'not json');

  clearStaleStudioRuns(store);

  assertEquals(keptStudioRunIds(store), ['current']);
});
