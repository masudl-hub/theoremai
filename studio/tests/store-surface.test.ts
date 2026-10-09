import { assert, assertEquals } from '@std/assert';
import { createSurfaceRuntime } from '../../src/surface/mod.ts';
import {
  createBlankDraft,
  type StudioDraft,
  type StudioWorkspace,
  setProfileType,
  workspaceFromDraft,
} from '../mod.ts';
import { type StudioSurfaceHost, studioSurface } from '../surface.ts';
import { createStudioStore } from '../ui/lib/studio-store.ts';

const KEY = ['AIzaSy', 'TESTONLY0000000000000000000000000'].join('');

function setup(draft: StudioDraft = setProfileType(createBlankDraft(), 'text')) {
  const store = createStudioStore({ workspace: workspaceFromDraft(draft), revision: 0 });
  const vault: Record<string, string> = {};
  const host: StudioSurfaceHost = {
    getDraft: store.getDraft,
    getRevision: store.getRevision,
    getMode: () => 'byok',
    update: (next) => store.updateDraft(next, 'th30'),
    replaceDraft: (next) => store.updateDraft(next, 'th30'),
    select: store.select,
    changesSince: (since) =>
      store.changesSince(since).map((change) => ({
        revision: change.revision,
        by: change.by === 'th30' ? 'agent' : 'person',
        sections: change.sections,
      })),
    subscribe: store.subscribe,
    key: (slot) => vault[slot] ?? '',
    openKeys: () => undefined,
    send: () => Promise.resolve(null),
    newConversation: () => undefined,
    launch: () => undefined,
    exportAgent: () => Promise.resolve(true),
  };
  const notes: string[] = [];
  const runtime = createSurfaceRuntime({ onNote: (line) => notes.push(line) });
  runtime.mount(studioSurface(host));
  return { store, vault, runtime, notes };
}

type Answer = Record<string, unknown>;

Deno.test("th30's set lands in the store as its own edit, and the visitor's makes the next one stale", async () => {
  const { store, runtime, notes } = setup();
  const applied = (await runtime.answer(
    'act',
    { at: 'studio/identity', action: 'set', input: { changes: { handle: 'pic' } }, basedOn: 0 },
    'c1',
  )) as Answer;
  assertEquals(applied.status, 'applied');
  assertEquals(store.getDraft().identity.handle, 'pic');
  assertEquals(store.changesSince(0)[0]?.by, 'th30');
  assertEquals(notes, []);
  store.updateDraft({
    ...store.getDraft(),
    identity: { ...store.getDraft().identity, system: 'x' },
  });
  assertEquals(notes.length, 1);
  const stale = (await runtime.answer(
    'act',
    { at: 'studio/identity', action: 'set', input: { changes: { handle: 'b' } }, basedOn: 1 },
    'c2',
  )) as Answer;
  assertEquals(stale.status, 'stale');
  assertEquals(store.getDraft().identity.handle, 'pic');
});

Deno.test('a key never leaves the page in a look', async () => {
  const { runtime, vault, store } = setup();
  const slot = store.getDraft().models.key || 'slot_a';
  vault[slot] = KEY;
  const view = await runtime.answer('look', { at: `studio/key:${slot}` }, 'c1');
  assert(!JSON.stringify(view).includes(KEY));
  assertEquals((view as { title?: string }).title, `Key ${slot}`);
  assert(!JSON.stringify(runtime.stateLine()).includes(KEY));
});

Deno.test('a kept draft masks tool credentials and leaves plain settings as typed', async () => {
  sessionStorage.clear();
  const { store, runtime } = setup();
  for (const toolName of ['weather', 'plain']) {
    await runtime.answer(
      'act',
      { at: 'studio', action: 'addTool', input: { toolName }, basedOn: store.getRevision() },
      toolName,
    );
  }
  const draft = store.getDraft();
  const [weather, other] = draft.toolSpecs.slice(-2);
  assert(weather && other);
  const plain = '{\n  "Accept": "application/json"\n}';
  store.updateDraft({
    ...draft,
    toolSpecs: draft.toolSpecs.map((spec) =>
      spec.key === weather.key
        ? {
            ...spec,
            endpoint: 'https://api.test/v1?api_key=s3cr3tvalue&city=Paris',
            headersJson: '{"X-Api-Key":"s3cr3theader"}',
          }
        : spec.key === other.key
          ? { ...spec, endpoint: 'https://api.test', headersJson: plain }
          : spec,
    ),
  });
  store.flush();
  const kept = sessionStorage.getItem('theorem.studio.v2') ?? '';
  assert(!kept.includes('s3cr3tvalue'));
  assert(!kept.includes('s3cr3theader'));
  assert(kept.includes('city=Paris'));
  const tools = (JSON.parse(kept) as { workspace: StudioWorkspace }).workspace.toolSpecs;
  const keptOther = tools.find((spec) => spec.key === other.key);
  assertEquals(keptOther?.endpoint, 'https://api.test');
  assertEquals(keptOther?.headersJson, plain);
  const live = store.getDraft().toolSpecs.find((spec) => spec.key === weather.key);
  assertEquals(live?.headersJson, '{"X-Api-Key":"s3cr3theader"}');
});
