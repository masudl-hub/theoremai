import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { createSurfaceRuntime } from '../../src/surface/runtime.ts';
import { createBlankDraft, type StudioDraft, setProfileType } from '../../studio/draft.ts';
import { createExampleDraft } from '../../studio/example.ts';
import {
  type StudioDraftChange,
  type StudioSurfaceHost,
  studioSurface,
} from '../../studio/surface.ts';

const KEY = ['AIzaSy', 'TESTONLY0000000000000000000000000'].join('');

function setup(start: StudioDraft = setProfileType(createBlankDraft(), 'text')) {
  let draft = start;
  let revision = 1;
  let changes: StudioDraftChange[] = [];
  const listeners = new Set<() => void>();
  const vault: Record<string, string> = {};
  const seen = {
    replaced: 0,
    selected: [] as string[],
    keysOpened: [] as string[],
    tested: [] as string[],
  };
  const commit = (next: StudioDraft, by: 'person' | 'agent') => {
    const before: Record<string, unknown> = { ...draft };
    const after: Record<string, unknown> = { ...next };
    const sections = Object.keys(after).filter((key) => before[key] !== after[key]);
    draft = next;
    revision += 1;
    changes = [...changes, { revision, by, sections }];
    for (const listener of listeners) listener();
  };
  const host: StudioSurfaceHost = {
    getDraft: () => draft,
    getRevision: () => revision,
    getMode: () => 'byok',
    update: (next) => {
      commit(next, 'agent');
      return undefined;
    },
    replaceDraft: (next) => {
      seen.replaced += 1;
      commit(next, 'agent');
    },
    select: (id, field) => seen.selected.push(field ? `${id}.${field}` : id),
    changesSince: (since) => changes.filter((change) => change.revision > since),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    key: (slot) => vault[slot] ?? '',
    toolCredential: () => 'tool-cred-0123456789',
    openKeys: (slot) => seen.keysOpened.push(slot ?? ''),
    testKey: (slot) => {
      seen.tested.push(slot);
      return Promise.resolve({
        ok: false,
        status: 400,
        said: `API key not valid: ${vault[slot] ?? ''}`,
      });
    },
    send: () => Promise.resolve(null),
    newConversation: () => undefined,
    launch: () => undefined,
    exportAgent: () => Promise.resolve(true),
  };
  const notes: string[] = [];
  const runtime = createSurfaceRuntime({ onNote: (line) => notes.push(line) });
  runtime.mount(studioSurface(host));
  const person = (next: StudioDraft) => commit(next, 'person');
  return {
    runtime,
    host,
    vault,
    seen,
    notes,
    person,
    draft: () => draft,
    revision: () => revision,
  };
}

type Answer = Record<string, unknown>;

Deno.test('the studio lists its sections and key slots', async () => {
  const { runtime } = setup();
  const view = (await runtime.answer('look', {}, 'c1')) as {
    surfaces: { nodes: { at: string }[] }[];
  };
  const at = view.surfaces[0]?.nodes.map((node) => node.at) ?? [];
  assert(at.includes('studio/identity'));
  assert(at.includes('studio/models'));
  assert(at.some((id) => id.startsWith('studio/key:')));
});

Deno.test('a key node shows a card, never the key, and its test result is scrubbed', async () => {
  const { runtime, vault, seen } = setup();
  const keys =
    (
      (await runtime.answer('look', {}, 'c1')) as { surfaces: { nodes: { at: string }[] }[] }
    ).surfaces[0]?.nodes.filter((node) => node.at.startsWith('studio/key:')) ?? [];
  const at = keys[0]?.at ?? '';
  const slot = at.slice('studio/key:'.length);
  vault[slot] = `${KEY} `;
  const view = (await runtime.answer('look', { at }, 'c2')) as { fields: Answer; issues: Answer[] };
  assert(!JSON.stringify(view).includes(KEY));
  assertEquals((view.fields.value as Answer).looksLike, 'Google API key');
  assertStringIncludes(JSON.stringify(view.issues), 'spaces or a line break around it');
  const tested = (await runtime.answer('act', { at, action: 'test' }, 'c3')) as Answer;
  assertEquals(seen.tested, [slot]);
  assert(!JSON.stringify(tested).includes(KEY));
  const pointed = (await runtime.answer('act', { at, action: 'point' }, 'c4')) as Answer;
  assertEquals(pointed.status, 'done');
  assertEquals(seen.keysOpened, [slot]);
});

Deno.test('set applies good settings and rejects the rest one by one', async () => {
  const { runtime, draft, revision } = setup();
  const result = (await runtime.answer(
    'act',
    {
      at: 'studio/identity',
      action: 'set',
      input: { changes: { handle: 'pic', nope: 1, profileType: 'image' } },
      basedOn: revision(),
    },
    'c1',
  )) as Answer;
  assertEquals(result.status, 'applied');
  assertEquals(draft().identity.handle, 'pic');
  assertEquals(
    (result.rejected as { field: string }[]).map((rejection) => rejection.field).sort(),
    ['nope', 'profileType'],
  );
});

Deno.test("the person's edit makes a write stale and is noted", async () => {
  const { runtime, person, draft, notes } = setup();
  person({ ...draft(), identity: { ...draft().identity, system: 'be brief' } });
  assertEquals(notes.length, 1);
  assertStringIncludes(notes[0] ?? '', 'the person changed Identity');
  const stale = (await runtime.answer(
    'act',
    { at: 'studio/identity', action: 'set', input: { changes: { handle: 'x' } }, basedOn: 1 },
    'c1',
  )) as Answer;
  assertEquals(stale.status, 'stale');
  assertEquals(stale.changed, ['studio/identity']);
});

Deno.test('newAgent with the same intent twice applies once', async () => {
  const { runtime, seen, revision } = setup();
  const first = await runtime.answer(
    'act',
    {
      at: 'studio',
      action: 'newAgent',
      input: { type: 'image' },
      basedOn: revision(),
      intent: 'pic',
    },
    'c1',
  );
  const again = await runtime.answer(
    'act',
    {
      at: 'studio',
      action: 'newAgent',
      input: { type: 'image' },
      basedOn: revision(),
      intent: 'pic',
    },
    'c2',
  );
  assertEquals(again, first);
  assertEquals(seen.replaced, 1);
  assertEquals((first as Answer).status, 'applied');
});

Deno.test('addModel and remove round-trip through the models section', async () => {
  const { runtime, draft, revision } = setup();
  const before = draft().modelBindings.length;
  const added = (await runtime.answer(
    'act',
    { at: 'studio', action: 'addModel', input: { modelId: 'second' }, basedOn: revision() },
    'c1',
  )) as { status: string; node: { at: string } };
  assertEquals(added.status, 'applied');
  assertEquals(draft().modelBindings.length, before + 1);
  const removed = (await runtime.answer(
    'act',
    { at: added.node.at, action: 'remove', basedOn: revision() },
    'c2',
  )) as Answer;
  assertEquals(removed.status, 'applied');
  assertEquals(draft().modelBindings.length, before);
});

Deno.test('a tool endpoint and headers reach the agent masked', async () => {
  const { runtime, draft, revision, person } = setup();
  await runtime.answer(
    'act',
    { at: 'studio', action: 'addTool', input: { toolName: 'weather' }, basedOn: revision() },
    'c1',
  );
  const tool = draft().toolSpecs.at(-1);
  assert(tool);
  person({
    ...draft(),
    toolSpecs: draft().toolSpecs.map((spec) =>
      spec.key === tool.key
        ? {
            ...spec,
            endpoint: 'https://api.weather.test/v1?appid=s3cr3tvalue&city=Paris',
            headersJson: '{"X-Api-Key":"s3cr3theader","Accept":"application/json"}',
          }
        : spec,
    ),
  });
  const view = (await runtime.answer(
    'look',
    { at: `studio/toolSpec:${tool.key}` },
    'c2',
  )) as Answer;
  const text = JSON.stringify(view);
  assert(!text.includes('s3cr3theader'));
  assert(!text.includes('s3cr3tvalue'));
  assertStringIncludes(text, 'city=Paris');
});

Deno.test('a tool with auth shows its test credential as a card', async () => {
  const { runtime, draft, revision, person } = setup();
  await runtime.answer(
    'act',
    { at: 'studio', action: 'addTool', input: { toolName: 'crm' }, basedOn: revision() },
    'c1',
  );
  const tool = draft().toolSpecs.at(-1);
  assert(tool);
  person({
    ...draft(),
    toolSpecs: draft().toolSpecs.map((spec) =>
      spec.key === tool.key ? { ...spec, authType: 'bearer' as const } : spec,
    ),
  });
  const view = (await runtime.answer('look', { at: `studio/toolSpec:${tool.key}` }, 'c2')) as {
    fields: Answer;
  };
  assertEquals((view.fields.credential as Answer).set, true);
  assert(!JSON.stringify(view).includes('tool-cred-0123456789'));
  const refused = (await runtime.answer(
    'act',
    {
      at: `studio/toolSpec:${tool.key}`,
      action: 'set',
      input: { changes: { credential: 'x' } },
      basedOn: revision(),
    },
    'c3',
  )) as Answer;
  assertStringIncludes(JSON.stringify(refused.rejected), 'only the person enters this');
});

Deno.test('try reports the reply: its text, media, tool calls and errors', async () => {
  const { runtime, host } = setup(createExampleDraft());
  const sent: string[] = [];
  host.send = (text) => {
    sent.push(text);
    return Promise.resolve({
      blocks: [
        { id: 'b1', kind: 'thought', text: 'unseen' },
        { id: 'b2', kind: 'text', text: 'Hello.' },
        { id: 'b3', kind: 'structured', value: { ok: true } },
        { id: 'b4', kind: 'media', mimeType: 'image/png' },
        {
          id: 'b5',
          kind: 'tool',
          tool: { name: 'lookup', callId: 'c', arguments: {}, artifacts: [] },
        },
        { id: 'b6', kind: 'error', message: 'quota' },
      ],
    });
  };
  const done = (await runtime.answer(
    'act',
    { at: 'studio', action: 'try', input: { message: 'Hi' } },
    'c1',
  )) as Answer;
  assertEquals(sent, ['Hi']);
  assertEquals(done.result, {
    sent: true,
    reply: 'Hello.\n{"ok":true}',
    media: [{ mimeType: 'image/png' }],
    tools: [{ name: 'lookup', state: undefined }],
    errors: ['quota'],
  });
});
