import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { z } from 'zod';
import {
  createSurfaceRuntime,
  defineAction,
  maskHeaders,
  maskUrl,
  type Surface,
  type SurfaceAuthor,
  type SurfaceChange,
  type SurfaceNode,
  secretCard,
} from '../../src/surface/mod.ts';

const KEY = ['AIzaSy', 'TESTONLY0000000000000000000000000'].join('');

/** A small page: a name, a key, an endpoint, and a key test. */
function page() {
  const state = {
    name: 'Ada',
    key: '',
    url: 'https://api.example.com/v1?api_key=hunter2hunter2&q=1',
  };
  let revision = 1;
  const changes: SurfaceChange[] = [];
  const listeners = new Set<() => void>();
  const pointed: string[] = [];
  const change = (by: SurfaceAuthor, nodes: string[]) => {
    revision += 1;
    changes.push({ revision, by, nodes });
    for (const listener of listeners) listener();
  };
  const nodes: SurfaceNode[] = [
    { id: '', title: 'Page' },
    {
      id: 'identity',
      title: 'Identity',
      parent: '',
      fields: () => ({
        name: { value: state.name, type: 'string', doc: 'What it is called' },
        handle: { value: 'ada', readOnly: 'set when the agent is made' },
      }),
      set: (next, ctx) => {
        if (typeof next.name !== 'string') return { rejected: [{ field: 'name', why: 'text' }] };
        state.name = next.name;
        change(ctx.by, ['identity']);
        return { rejected: [] };
      },
      point: (field) => pointed.push(field ?? 'identity'),
    },
    {
      id: 'key',
      title: 'Key',
      parent: '',
      fields: () => ({
        key: { value: state.key, format: 'secret', usedBy: ['model'] },
        url: { value: state.url, format: 'url' },
        headers: { value: '{"Authorization":"Bearer abc","Accept":"json"}', format: 'headers' },
      }),
      set: () => ({ rejected: [] }),
      point: (field) => pointed.push(field ?? 'key'),
      actions: {
        test: defineAction({
          description: 'Try the key',
          effect: 'run',
          input: z.object({ verbose: z.boolean().optional() }),
          run: () => ({ result: { ok: false, said: `bad key ${state.key}` } }),
        }),
        reset: defineAction({
          description: 'Start over',
          effect: 'write',
          intent: true,
          run: (_input, ctx) => {
            state.name = '';
            change(ctx.by, ['identity']);
            return { node: 'identity' };
          },
        }),
        boom: defineAction({
          description: 'Fails',
          effect: 'run',
          run: () => {
            throw new Error(`could not use ${state.key}`);
          },
        }),
      },
    },
  ];
  const surface: Surface = {
    id: 'page',
    title: 'Page',
    revision: () => revision,
    summary: () => `${state.name || 'unnamed'}; key ${state.key ? 'set' : 'missing'}`,
    nodes: () => nodes,
    issues: () => (state.key ? [] : [{ node: 'key', field: 'key', message: 'No key' }]),
    changesSince: (since) => changes.filter((c) => c.revision > since),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { surface, state, change, pointed };
}

type Answer = Record<string, unknown>;

Deno.test('look with no at lists surfaces, nodes and issue counts', async () => {
  const runtime = createSurfaceRuntime();
  const { surface } = page();
  runtime.mount(surface);
  const view = (await runtime.answer('look', {}, 'c1')) as { surfaces: Answer[] };
  assertEquals(view.surfaces[0]?.at, 'page');
  assertEquals(view.surfaces[0]?.issues, 1);
  assertEquals(view.surfaces[0]?.nodes, [
    { at: 'page/identity', title: 'Identity' },
    { at: 'page/key', title: 'Key', issues: 1 },
  ]);
});

Deno.test('a secret field reaches the agent only as a card, and url and headers are masked', async () => {
  const runtime = createSurfaceRuntime();
  const { surface, state } = page();
  state.key = ` ${KEY}\n`;
  runtime.mount(surface);
  const view = (await runtime.answer('look', { at: 'page/key' }, 'c1')) as { fields: Answer };
  const text = JSON.stringify(view);
  assert(!text.includes(KEY), 'the key leaked');
  assert(!text.includes('hunter2hunter2'), 'the url credential leaked');
  assert(!text.includes('Bearer abc'), 'the header leaked');
  assertEquals(view.fields.key, {
    secret: true,
    set: true,
    looksLike: 'Google API key',
    problems: ['spaces or a line break around it'],
    sameAs: [],
    usedBy: ['model'],
  });
  assertStringIncludes(String(view.fields.url), 'q=1');
});

Deno.test('act set refuses secrets and read-only fields and applies the rest', async () => {
  const runtime = createSurfaceRuntime();
  const { surface, state } = page();
  runtime.mount(surface);
  const refused = (await runtime.answer(
    'act',
    { at: 'page/key', action: 'set', input: { changes: { key: KEY } }, basedOn: 1 },
    'c1',
  )) as Answer;
  assertEquals(refused.status, 'unchanged');
  assertStringIncludes(JSON.stringify(refused.rejected), 'only the person enters this');
  const applied = (await runtime.answer(
    'act',
    {
      at: 'page/identity',
      action: 'set',
      input: { changes: { name: 'Grace', handle: 'g' } },
      basedOn: 1,
    },
    'c2',
  )) as Answer;
  assertEquals(applied.status, 'applied');
  assertEquals(applied.changed, ['page/identity']);
  assertEquals(applied.rejected, [{ field: 'handle', why: 'set when the agent is made' }]);
  assertEquals(state.name, 'Grace');
});

Deno.test('writes need basedOn, and a stale one applies nothing', async () => {
  const runtime = createSurfaceRuntime();
  const { surface, state, change } = page();
  runtime.mount(surface);
  const missing = (await runtime.answer(
    'act',
    { at: 'page/identity', action: 'set', input: { changes: { name: 'X' } } },
    'c1',
  )) as Answer;
  assertEquals(missing.status, 'refused');
  change('person', ['identity']);
  const stale = (await runtime.answer(
    'act',
    { at: 'page/identity', action: 'set', input: { changes: { name: 'X' } }, basedOn: 1 },
    'c2',
  )) as Answer;
  assertEquals(stale.status, 'stale');
  assertEquals(stale.changed, ['page/identity']);
  assertEquals(state.name, 'Ada');
});

Deno.test('a repeated call id replays, and a repeated intent applies once', async () => {
  let time = 0;
  const runtime = createSurfaceRuntime({ now: () => time });
  const { surface } = page();
  runtime.mount(surface);
  const first = await runtime.answer(
    'act',
    { at: 'page/key', action: 'reset', basedOn: 1, intent: 'fresh' },
    'c1',
  );
  const again = await runtime.answer(
    'act',
    { at: 'page/key', action: 'reset', basedOn: 1, intent: 'fresh' },
    'c1',
  );
  assertEquals(again, first);
  const repeat = await runtime.answer(
    'act',
    { at: 'page/key', action: 'reset', basedOn: 2, intent: 'fresh' },
    'c2',
  );
  assertEquals(repeat, first);
  assertEquals(surface.revision(), 2);
  time = 61_000;
  const later = (await runtime.answer(
    'act',
    { at: 'page/key', action: 'reset', basedOn: 2, intent: 'fresh' },
    'c3',
  )) as Answer;
  assertEquals(later.status, 'applied');
});

Deno.test('action results and failures are scrubbed of known secrets', async () => {
  const runtime = createSurfaceRuntime();
  const { surface, state } = page();
  state.key = KEY;
  runtime.mount(surface);
  const done = (await runtime.answer('act', { at: 'page/key', action: 'test' }, 'c1')) as Answer;
  assertEquals(done.status, 'done');
  assert(!JSON.stringify(done).includes(KEY));
  assertStringIncludes(JSON.stringify(done), '[secret page/key.key]');
  const failed = (await runtime.answer('act', { at: 'page/key', action: 'boom' }, 'c2')) as Answer;
  assertEquals(failed.status, 'failed');
  assert(!JSON.stringify(failed).includes(KEY));
});

Deno.test('bad input comes back as rejections; unknown nodes and actions are refused', async () => {
  const runtime = createSurfaceRuntime();
  runtime.mount(page().surface);
  const bad = (await runtime.answer(
    'act',
    { at: 'page/key', action: 'test', input: { verbose: 'yes' } },
    'c1',
  )) as Answer;
  assertEquals(bad.status, 'refused');
  assertEquals((bad.rejected as Answer[])[0]?.field, 'verbose');
  const nowhere = (await runtime.answer('look', { at: 'page/nope' }, 'c2')) as Answer;
  assertEquals(nowhere.status, 'refused');
  const noAction = (await runtime.answer(
    'act',
    { at: 'page/identity', action: 'fly' },
    'c3',
  )) as Answer;
  assertStringIncludes(String(noAction.why), 'set, point');
});

Deno.test('point shows the person a field', async () => {
  const runtime = createSurfaceRuntime();
  const { surface, pointed } = page();
  runtime.mount(surface);
  const shown = (await runtime.answer(
    'act',
    { at: 'page/key', action: 'point', input: { field: 'key' } },
    'c1',
  )) as Answer;
  assertEquals(shown.status, 'done');
  assertEquals(pointed, ['key']);
});

Deno.test("notes tell only the person's changes, and a cancelled applied call", async () => {
  const notes: string[] = [];
  const runtime = createSurfaceRuntime({ onNote: (line) => notes.push(line) });
  const { surface, change } = page();
  runtime.mount(surface);
  await runtime.answer(
    'act',
    { at: 'page/identity', action: 'set', input: { changes: { name: 'B' } }, basedOn: 1 },
    'c1',
  );
  assertEquals(notes, []);
  change('person', ['key']);
  assertEquals(notes, ['page r3: the person changed Key; 1 issue']);
  runtime.settled('c1', 'cancelled');
  assertStringIncludes(notes[1] ?? '', 'cancelled');
  runtime.settled('unknown', 'cancelled');
  assertEquals(notes.length, 2);
});

Deno.test('a declared surface opens when looked at', async () => {
  const runtime = createSurfaceRuntime({
    mountWaitMs: 200,
    open: (id) => {
      if (id === 'page') queueMicrotask(() => runtime.mount(page().surface));
    },
  });
  runtime.declare('page', 'Page');
  const listed = (await runtime.answer('look', {}, 'c1')) as Answer;
  assertEquals((listed.closed as Answer[])[0]?.at, 'page');
  const view = (await runtime.answer('look', { at: 'page/identity' }, 'c2')) as Answer;
  assertEquals(view.title, 'Identity');
});

Deno.test('stateLine names each surface and the last calls, scrubbed', async () => {
  const runtime = createSurfaceRuntime();
  assertEquals(runtime.stateLine(), null);
  const { surface } = page();
  runtime.mount(surface);
  await runtime.answer('act', { at: 'page/key', action: 'test' }, 'c1');
  assertEquals(runtime.stateLine(), '(state) page r1: Ada; key missing; last calls: page/key test');
});

Deno.test('secretCard tells placeholders, quotes and sameAs', () => {
  assertEquals(secretCard('<your key>').problems, ['a placeholder, not a real value']);
  assertEquals(secretCard('"abcdefghijklmnopqrstu"').problems, ['wrapped in quotes']);
  assertEquals(secretCard('', { sameAs: ['x'] }).set, false);
});

Deno.test('maskUrl and maskHeaders hide credentials and never quote bad text', () => {
  assertEquals(
    maskUrl('https://u:p@h.com/x?token=abc&q=2'),
    'https://••••:••••@h.com/x?token=••••&q=2',
  );
  assertEquals(
    maskHeaders('{"X-Api-Key":"abc","Accept":"json"}'),
    '{"X-Api-Key":"••••","Accept":"json"}',
  );
  assertEquals(maskHeaders('Authorization: abc'), '(not a JSON object, 18 characters)');
  assertEquals(maskUrl('https://h.com'), 'https://h.com');
});
