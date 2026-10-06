import { assertEquals } from '@std/assert';
import {
  compilePlayground,
  createExampleDraft,
  type PlaygroundRunPayload,
  playgroundRunDefines,
} from '../../playground/mod.ts';

function exampleRun(): PlaygroundRunPayload {
  const result = compilePlayground(createExampleDraft());
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result;
}

Deno.test('a run this package compiled defines', () => {
  assertEquals(playgroundRunDefines(exampleRun()), true);
});

Deno.test('a run kept with a setting this package no longer takes does not define', () => {
  const run = exampleRun();
  const kept = {
    ...run,
    profile: {
      ...run.profile,
      guardrails: { ...run.profile.guardrails, blockedReply: { action: 'refuse' } },
    },
  } as unknown as PlaygroundRunPayload;
  assertEquals(playgroundRunDefines(kept), false);
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
  } as unknown as PlaygroundRunPayload;
  assertEquals(playgroundRunDefines(kept), false);
});
