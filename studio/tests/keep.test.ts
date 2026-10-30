import { assert, assertEquals } from '@std/assert';
import { ON_OWN_KEYS } from '../lent-keys.ts';
import {
  compileStudio,
  createExampleDraft,
  maskedStudioRun,
  type StudioRunPayload,
  studioRunCredentials,
  studioRunIsMasked,
  withStudioRunCredentials,
  workspaceFromDraft,
} from '../mod.ts';
import { handOffStudioRun } from '../ui/lib/run-keys.ts';
import { pageConversationKey } from '../ui/lib/studio-conversation.ts';
import { GONE_MS, memoryKeep, sweepPlan } from '../ui/lib/studio-keep.ts';
import { takeRun } from '../ui/lib/studio-session.ts';
import { createStudioStore } from '../ui/lib/studio-store.ts';
import { tab, written } from './tab.ts';

/** Credentials no record the browser keeps may hold. */
const SECRETS = ['s3cr3tquery', 's3cr3theader', 's3cr3tpass', 's3cr3tmcp'];

/** The example's run, its tools carrying credentials in their URLs and headers. */
function runWithCredentials(): StudioRunPayload {
  const compiled = compileStudio(createExampleDraft(), ON_OWN_KEYS);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  const [first, ...rest] = compiled.customTools;
  assert(first?.type === 'http');
  return {
    ...compiled,
    customTools: [
      {
        ...first,
        endpoint: 'https://user:s3cr3tpass@api.test/v1?api_key=s3cr3tquery&city=Paris',
        headers: { 'X-Api-Key': 's3cr3theader', Accept: 'application/json' },
      },
      {
        ...first,
        type: 'mcp',
        name: 'remote',
        serverUrl: 'https://mcp.test/sse?token=s3cr3tmcp',
      } as unknown as StudioRunPayload['customTools'][number],
      ...rest,
    ],
  };
}

Deno.test('a kept run masks its tools’ credentials, and they come back from the studio tab', () => {
  const run = runWithCredentials();
  const masked = maskedStudioRun(run);
  const shown = JSON.stringify(masked);
  for (const secret of SECRETS) assert(!shown.includes(secret), secret);
  assert(shown.includes('city=Paris'));
  assert(studioRunIsMasked(run));
  assertEquals(withStudioRunCredentials(masked, studioRunCredentials(run)), run);
});

Deno.test('nothing the studio keeps in the browser holds a credential or the tab’s key', async () => {
  written.length = 0;
  const run = runWithCredentials();
  const id = handOffStudioRun(run);
  const store = createStudioStore({
    workspace: workspaceFromDraft(createExampleDraft()),
    revision: 0,
  });
  store.updateDraft((draft) => ({
    ...draft,
    toolSpecs: draft.toolSpecs.map((spec, at) =>
      at === 0
        ? {
            ...spec,
            endpoint: 'https://user:s3cr3tpass@api.test/v1?api_key=s3cr3tquery',
            headersJson: '{"X-Api-Key":"s3cr3theader"}',
          }
        : spec,
    ),
  }));
  store.flush();
  const key = pageConversationKey();
  assert(written.length >= 2, 'the run and the workspace were kept');
  for (const value of written) {
    for (const secret of [...SECRETS, key]) assert(!value.includes(secret), secret);
  }
  const taken = await takeRun(id);
  assert(taken && !SECRETS.some((secret) => taken.includes(secret)));
  tab.clear();
});

Deno.test('a sweep marks a tab gone, and clears it only once it has been gone a while', () => {
  const now = 1_000_000;
  const gone = new Map([
    ['closed', now - GONE_MS],
    ['reloading', now - 10],
    ['back', now - GONE_MS * 2],
  ]);
  const plan = sweepPlan(
    ['open', 'new', 'closed', 'reloading'],
    gone,
    new Set(['open', 'back']),
    now,
  );
  assertEquals(plan, { seen: ['new'], back: ['back'], clear: ['closed'] });
});

Deno.test('a duplicated tab starts with a copy of its records, and a run is taken once', async () => {
  const keep = memoryKeep();
  await keep.claim('a', undefined);
  keep.put('a', 'workspace', 'w');
  keep.handOff('r', 'a', 'run');
  assertEquals(await keep.claim('b', 'a'), [['workspace', 'w']]);
  assertEquals(await keep.takeRun('r', 'b', 'run:r'), 'run');
  assertEquals(await keep.takeRun('r', 'c', 'run:r'), undefined);
  await keep.sweep(new Set(['b']), 0);
  await keep.sweep(new Set(['b']), GONE_MS);
  assertEquals(await keep.claim('a', undefined), []);
  assertEquals(await keep.claim('b', undefined), [
    ['workspace', 'w'],
    ['run:r', 'run'],
  ]);
});
