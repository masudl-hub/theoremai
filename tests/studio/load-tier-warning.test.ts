import { assertEquals } from '@std/assert';
import { createBlankDraft, loadTierWarning, type StudioDraft } from '../../studio/draft.ts';

const NEVER_LOADS = 'No T2 loader is set under Tools, so this tool never loads.';
const tool = { key: 'tool-a', loadTier: 'T2' } as const;

function draftWith(t2Loader: string): StudioDraft {
  const draft = createBlankDraft();
  return {
    ...draft,
    identity: { ...draft.identity, profileType: 'text' },
    tools: { ...draft.tools, t2Loader },
  };
}

Deno.test('a T2 tool this agent runs with no loader never loads', () => {
  assertEquals(loadTierWarning(draftWith(''), tool, ['tool-a']), NEVER_LOADS);
});

Deno.test('a T2 tool on a single agent counts as its own', () => {
  assertEquals(loadTierWarning(draftWith(''), tool), NEVER_LOADS);
});

Deno.test('a library tool this agent does not run says nothing about loading', () => {
  assertEquals(loadTierWarning(draftWith(''), tool, ['tool-b']), undefined);
});

Deno.test('a T2 tool on an agent with a loader loads', () => {
  assertEquals(loadTierWarning(draftWith('load_tools'), tool, ['tool-a']), undefined);
});

Deno.test('a T0 tool needs no loader', () => {
  assertEquals(
    loadTierWarning(draftWith(''), { key: 'tool-a', loadTier: 'T0' }, ['tool-a']),
    undefined,
  );
});
