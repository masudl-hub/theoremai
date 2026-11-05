import { assertEquals } from '@std/assert';
import { ON_OWN_KEYS } from '../../studio/lent-keys.ts';
import {
  compileStudio,
  createExampleDraft,
  type StudioRunPayload,
  studioInterface,
  studioRunDefines,
} from '../../studio/mod.ts';

function exampleRun(): StudioRunPayload {
  const result = compileStudio(createExampleDraft(), ON_OWN_KEYS);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result;
}

Deno.test('a run this package compiled defines', () => {
  assertEquals(studioRunDefines(exampleRun()), true);
});

Deno.test("a run with the builder's own patterns defines, and its interface opens", () => {
  const draft = createExampleDraft();
  const ids = {
    theorem: true,
    hint: '',
    patterns: [
      { name: 'order', kind: 'pattern' as const, pattern: 'ORD-\\d{6}', flags: 'i', words: [] },
    ],
  };
  const result = compileStudio(
    {
      ...draft,
      guardrails: { ...draft.guardrails, sources: { ...draft.guardrails.sources, ids } },
    },
    ON_OWN_KEYS,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  assertEquals(studioRunDefines(result), true);
  assertEquals(studioInterface(result).type, result.profile.type);
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
