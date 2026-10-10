import { assertEquals } from '@std/assert';
import registerExample from '../../studio/server/example.ts';
import { createStudioHandler, type StudioDescription } from '../../studio/server/handler.ts';
import {
  answerSave,
  createSaveSession,
  isSaveRequest,
  pageOrigins,
  type SaveHost,
} from '../../studio/server/save-session.ts';
import type { SaveDone, SaveRefusal, SaveReview } from '../../studio/server/save-wire.ts';
import {
  removeLibraryTool,
  type StudioWorkspace,
  setToolAllowed,
  startedHere,
} from '../../studio/workspace.ts';

registerExample();
const opened: StudioDescription = await (
  await createStudioHandler({
    project: 'garden',
    pageOrigins: ['http://localhost:5174'],
    listenHost: '127.0.0.1:4983',
  })(new Request('http://127.0.0.1:4983/api/studio', { headers: { host: '127.0.0.1:4983' } }))
).json();

const SETUP = new URL('../../studio/server/example.ts', import.meta.url).pathname;
const ROOT = new URL('../../studio/server', import.meta.url).pathname;
const TEXT = Deno.readTextFileSync(SETUP);
const ALLOWED = "tools: { allow: ['list_plants', 'log_watering', 'remove_plant'] },";

/** The example with `remove_plant` allowed: the edit every test here saves. */
function edited(): StudioWorkspace {
  const { workspace } = opened;
  const agent = workspace.agents[0];
  const removal = workspace.toolSpecs.find((tool) => tool.toolName === 'remove_plant');
  if (!agent || !removal) throw new Error('The example changed.');
  return setToolAllowed(workspace, agent.key, removal.key, true);
}

/** A project held in memory. Each load is the workspace `loads` holds then; nothing touches the disk. */
function project(over: Partial<SaveHost<StudioWorkspace>> = {}) {
  const files = new Map([[SETUP, TEXT]]);
  const stopped: StudioWorkspace[] = [];
  const state = { loads: opened.workspace };
  const session = createSaveSession<StudioWorkspace>(
    {
      root: ROOT,
      setupFile: SETUP,
      read: (path) => files.get(path),
      write: (path, text) => void files.set(path, text),
      remove: (path) => void files.delete(path),
      typeChecks: () => Promise.resolve({ ok: true, output: '' }),
      load: () => Promise.resolve(state.loads),
      stop: (loaded) => Promise.resolve(void stopped.push(loaded)),
      opened: (loaded) => loaded,
      ...over,
    },
    opened.workspace,
  );
  return { session, files, stopped, state, text: () => files.get(SETUP) ?? '' };
}

async function reviewed(
  session: ReturnType<typeof project>['session'],
  workspace: StudioWorkspace,
) {
  const review = (await session.save({ workspace })) as SaveReview;
  if (!review.ok) throw new Error('The review was refused.');
  return review;
}

Deno.test('a request without a stamp is a review: the changed lines, and nothing written', async () => {
  const { session, text } = project();
  const review = await reviewed(session, edited());
  assertEquals(review.writable, true);
  assertEquals(
    review.files.map(({ file, hunks }) => [file, hunks.map((hunk) => hunk.added)]),
    [['example.ts', [[`      ${ALLOWED}`]]]],
  );
  assertEquals(text(), TEXT);
  const untouched = await reviewed(session, opened.workspace);
  assertEquals([untouched.files, untouched.writable], [[], false]);
});

Deno.test('Save writes the reviewed lines, answers from the new load, and undo puts both back', async () => {
  const { session, text, state, stopped } = project();
  const workspace = edited();
  const { stamp } = await reviewed(session, workspace);
  state.loads = startedHere(workspace);
  assertEquals(await session.save({ workspace, stamp }), { ok: true, written: ['example.ts'] });
  assertEquals(text().includes(ALLOWED), true);
  assertEquals(session.project(), state.loads);
  assertEquals(stopped, [opened.workspace]);

  const saved = state.loads;
  state.loads = opened.workspace;
  assertEquals(await session.undo(), { ok: true, written: ['example.ts'] });
  assertEquals(text(), TEXT);
  assertEquals(session.project(), opened.workspace);
  assertEquals(stopped, [opened.workspace, saved]);
  assertEquals(((await session.undo()) as SaveRefusal).reason, 'nothing');
});

Deno.test('a file that changed after the review, or after the save, is left as it is', async () => {
  const { session, files, text, state } = project();
  const workspace = edited();
  const { stamp } = await reviewed(session, workspace);
  files.set(SETUP, `${TEXT}// edited elsewhere\n`);
  assertEquals(((await session.save({ workspace, stamp })) as SaveRefusal).reason, 'stale');
  assertEquals(text(), `${TEXT}// edited elsewhere\n`);

  const again = await reviewed(session, workspace);
  state.loads = startedHere(workspace);
  assertEquals(((await session.save({ workspace, stamp: again.stamp })) as SaveDone).ok, true);
  const moved = `${text()}// and again\n`;
  files.set(SETUP, moved);
  assertEquals(await session.undo(), { ok: false, reason: 'stale', detail: ['example.ts'] });
  assertEquals(text(), moved);
});

Deno.test('a save that fails a proof puts the files back and keeps the old load', async () => {
  const workspace = edited();
  const cases: [SaveRefusal['reason'], string[], Partial<SaveHost<StudioWorkspace>>][] = [
    ['check', ['TS2322'], { typeChecks: () => Promise.resolve({ ok: false, output: 'TS2322' }) }],
    ['load', ['It threw.'], { load: () => Promise.reject(new Error('It threw.')) }],
    // The load is the project as it opened, not what was tested.
    ['differs', ['garden-desk', 'remove_plant'], {}],
  ];
  for (const [reason, detail, over] of cases) {
    const { session, text, stopped } = project(over);
    const { stamp } = await reviewed(session, workspace);
    assertEquals(await session.save({ workspace, stamp }), { ok: false, reason, detail });
    assertEquals(text(), TEXT);
    assertEquals(session.project(), opened.workspace);
    assertEquals(stopped.length, reason === 'differs' ? 1 : 0);
  }
});

Deno.test('files the editor changed are loaded again, and ones that do not load leave the last load', async () => {
  let loads = 0;
  const failing = { fails: false };
  const { session, files, stopped, state } = project({
    load: () => {
      loads += 1;
      return failing.fails ? Promise.reject(new Error('It threw.')) : Promise.resolve(state.loads);
    },
  });
  // Files as they loaded start nothing.
  assertEquals(await session.refresh(), undefined);
  assertEquals(loads, 0);
  assertEquals(session.watched(), [SETUP]);
  assertEquals(await session.changed(), []);

  const next = edited();
  state.loads = next;
  files.set(SETUP, `${TEXT}\n// An edit in the editor.\n`);
  // The watch names the file from the project's folder until the load takes it in.
  assertEquals((await session.changed()).length, 1);
  assertEquals(await session.refresh(), undefined);
  assertEquals(await session.changed(), []);
  assertEquals(session.project(), next);
  assertEquals([loads, stopped.length], [1, 1]);

  // Files that do not load are tried once, and the last load answers.
  failing.fails = true;
  files.set(SETUP, `${TEXT}\n// A broken edit.\n`);
  assertEquals(await session.refresh(), 'It threw.');
  assertEquals(await session.refresh(), 'It threw.');
  assertEquals(session.project(), next);
  assertEquals(loads, 2);

  failing.fails = false;
  files.set(SETUP, `${TEXT}\n// Mended.\n`);
  assertEquals(await session.refresh(), undefined);
  assertEquals(loads, 3);
});

Deno.test('an undo whose load fails writes the save again', async () => {
  let fail = false;
  const workspace = edited();
  const { session, text, state } = project({
    load: () =>
      fail ? Promise.reject(new Error('It threw.')) : Promise.resolve(startedHere(workspace)),
  });
  const { stamp } = await reviewed(session, workspace);
  state.loads = startedHere(workspace);
  await session.save({ workspace, stamp });
  fail = true;
  assertEquals(await session.undo(), { ok: false, reason: 'load', detail: ['It threw.'] });
  assertEquals(text().includes(ALLOWED), true);
});

/** The example with a second agent beside the first: the same settings under another id. */
function withSecond(workspace: StudioWorkspace): StudioWorkspace {
  const [agent] = workspace.agents;
  if (!agent) throw new Error('The example changed.');
  const second = {
    ...agent,
    key: 'second',
    identity: { ...agent.identity, agentId: 'second-desk' },
  };
  return { ...workspace, agents: [agent, second] };
}

const SECOND = SETUP.replace('example.ts', 'second-desk.ts');

Deno.test('an agent added in the studio is a new file beside the others, registered in the setup file', async () => {
  const { session, files, text, state } = project();
  const workspace = withSecond(opened.workspace);
  const review = await reviewed(session, workspace);
  assertEquals(
    review.changes.map(({ of, status, file }) => [of, status, file]),
    [['second-desk', 'written', 'second-desk.ts']],
  );
  assertEquals(review.writable, true);
  assertEquals(
    review.files.map(({ file, created, hunks }) => [
      file,
      created,
      hunks.flatMap((hunk) => hunk.added),
    ]),
    [
      [
        'second-desk.ts',
        true,
        [
          "import { defineProfile } from '../../mod.ts';",
          '',
          'export const profile = defineProfile({',
          "  type: 'host',",
          "  id: 'second-desk',",
          '  tools: {',
          "    allow: ['list_plants', 'log_watering'],",
          '  },',
          '});',
        ],
      ],
      [
        'example.ts',
        undefined,
        [
          "import * as secondDesk from './second-desk.ts';",
          '  registerProfile(secondDesk.profile);',
        ],
      ],
    ],
  );
  assertEquals([text(), files.has(SECOND)], [TEXT, false]);

  state.loads = startedHere(workspace);
  assertEquals(await session.save({ workspace, stamp: review.stamp }), {
    ok: true,
    written: ['second-desk.ts', 'example.ts'],
  });
  assertEquals(
    files.get(SECOND)?.startsWith("import { defineProfile } from '../../mod.ts';\n"),
    true,
  );
  assertEquals(text().includes('  registerProfile(secondDesk.profile);\n}'), true);

  state.loads = opened.workspace;
  assertEquals(await session.undo(), { ok: true, written: ['second-desk.ts', 'example.ts'] });
  assertEquals([text(), files.has(SECOND)], [TEXT, false]);
});

Deno.test('a new agent whose file is already there is not written over', async () => {
  const { session, files } = project();
  files.set(SECOND, '// mine\n');
  const review = await reviewed(session, withSecond(opened.workspace));
  assertEquals(
    review.changes.map(({ status, file }) => [status, file]),
    [['taken', 'second-desk.ts']],
  );
  assertEquals([review.writable, review.files, files.get(SECOND)], [false, [], '// mine\n']);
});

Deno.test('a new file that fails a proof is taken away again', async () => {
  const { session, files, text } = project();
  const workspace = withSecond(opened.workspace);
  const { stamp } = await reviewed(session, workspace);
  // The load is the project as it opened, without the new agent.
  assertEquals(await session.save({ workspace, stamp }), {
    ok: false,
    reason: 'differs',
    detail: ['second-desk'],
  });
  assertEquals([text(), files.has(SECOND)], [TEXT, false]);
});

Deno.test('a change Save cannot write turns Save off, and a workspace it cannot read is refused', async () => {
  const { session, files, text } = project();
  const workspace = edited();
  const [agent] = workspace.agents;
  if (!agent) throw new Error('The example changed.');
  // The file holds on to what registering the tool returns, so the studio cannot take the line out.
  const HELD = TEXT.replace(
    "registerTool({\n    type: 'function',\n    name: 'list_plants'",
    "void registerTool({\n    type: 'function',\n    name: 'list_plants'",
  );
  files.set(SETUP, HELD);
  const removed = {
    ...workspace,
    toolSpecs: workspace.toolSpecs.filter((tool) => tool.toolName !== 'list_plants'),
  };
  const review = await reviewed(session, removed);
  assertEquals(
    review.changes
      .filter(({ status }) => status !== 'written')
      .map(({ of, status, file }) => [of, status, file]),
    [['list_plants', 'removed', 'example.ts']],
  );
  assertEquals(review.writable, false);
  assertEquals(
    ((await session.save({ workspace: removed, stamp: review.stamp })) as SaveRefusal).reason,
    'unwritable',
  );
  assertEquals(text(), HELD);

  const broken = {
    ...workspace,
    agents: [{ ...agent, identity: { ...agent.identity, agentId: '' } }],
  };
  assertEquals(((await session.save({ workspace: broken })) as SaveRefusal).reason, 'issues');
  assertEquals(isSaveRequest({ workspace }), true);
  assertEquals([isSaveRequest(null), isSaveRequest({ workspace: { agents: [] } })], [false, false]);
});

Deno.test('the page reads what the files set in code, with each file from the project, and what no file defines', () => {
  const { session } = project();
  const { tools, profiles } = session.origins();
  assertEquals(profiles, {});
  assertEquals(
    tools.remove_plant?.map(({ path, kind, file }) => [path.join('.'), kind, file]),
    [
      ['handler', 'code', 'example.ts'],
      ['outputSchema', 'code', 'example.ts'],
      ['inputSchema', 'code', 'example.ts'],
    ],
  );
  assertEquals(
    [session.place('example.ts'), session.place('../mod.ts'), session.place('missing.ts')],
    [SETUP, undefined, undefined],
  );

  const names = { profiles: ['garden-desk', 'made-in-a-loop'], tools: ['remove_plant'] };
  const defined = { profiles: new Map([['garden-desk', []]]), tools: new Map() };
  const found = {
    profiles: {
      'garden-desk': [{ path: ['inputs'], kind: 'code' as const, file: `${ROOT}/a.ts`, line: 2 }],
    },
    tools: {},
  };
  assertEquals(
    pageOrigins(found, names, defined, (file) => file.replace(`${ROOT}/`, '')),
    {
      profiles: {
        'garden-desk': [{ path: ['inputs'], kind: 'code', file: 'a.ts', line: 2 }],
        'made-in-a-loop': [{ path: [], kind: 'unfound' }],
      },
      tools: { remove_plant: [{ path: [], kind: 'unfound' }] },
    },
  );
});

Deno.test('Save answers its own two addresses, and leaves every other request alone', async () => {
  const { session, state } = project();
  const workspace = edited();
  const at = (path: string, method: string, body?: unknown) =>
    answerSave(
      session,
      '/api/studio/save',
      new Request(`http://127.0.0.1:4983${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  assertEquals(await at('/api/studio/save', 'GET'), undefined);
  assertEquals(await at('/api/studio/run', 'POST', {}), undefined);
  assertEquals(await at('/api/studio/save', 'POST', { workspace: 1 }), { status: 400, body: {} });
  assertEquals(await at('/api/studio/save', 'POST'), { status: 400, body: {} });

  const review = (await at('/api/studio/save', 'POST', { workspace }))?.body as SaveReview;
  assertEquals([review.ok, review.writable], [true, true]);
  state.loads = startedHere(workspace);
  assertEquals(await at('/api/studio/save', 'POST', { workspace, stamp: review.stamp }), {
    status: 200,
    body: { ok: true, written: ['example.ts'] },
  });
  state.loads = opened.workspace;
  assertEquals(await at('/api/studio/save/undo', 'POST'), {
    status: 200,
    body: { ok: true, written: ['example.ts'] },
  });
});

/** The example with `remove_plant`, which no agent allows, taken away. */
function withoutRemoval(): StudioWorkspace {
  const { workspace } = opened;
  const removal = workspace.toolSpecs.find((tool) => tool.toolName === 'remove_plant');
  if (!removal) throw new Error('The example changed.');
  return removeLibraryTool(workspace, removal.key);
}

Deno.test('a tool the studio removed is taken out of the file, and undo puts it back', async () => {
  const { session, text, state } = project();
  const workspace = withoutRemoval();
  const review = await reviewed(session, workspace);
  assertEquals(
    [review.writable, review.changes.map(({ of, status }) => [of, status])],
    [true, [['remove_plant', 'written']]],
  );
  const [hunk] = review.files[0]?.hunks ?? [];
  assertEquals([hunk?.added, hunk?.removed.at(0)], [[], '  registerTool({']);
  assertEquals(text(), TEXT);

  state.loads = startedHere(workspace);
  assertEquals(await session.save({ workspace, stamp: review.stamp }), {
    ok: true,
    written: ['example.ts'],
  });
  assertEquals([text().includes('remove_plant'), text().includes('log_watering')], [false, true]);
  state.loads = opened.workspace;
  assertEquals(await session.undo(), { ok: true, written: ['example.ts'] });
  assertEquals(text(), TEXT);
});

Deno.test('a file left with nothing of its own is taken away, and comes back on undo or a failed proof', async () => {
  const OWN = `${ROOT}/removal.ts`;
  const start = TEXT.indexOf("  registerTool({\n    type: 'function',\n    name: 'remove_plant'");
  const end = TEXT.indexOf('  registerProfile(');
  const MOVED = `import { registerTool, z } from '../../mod.ts';\n\n${TEXT.slice(start, end).trim()}\n`;
  const SPLIT = `import './removal.ts';\n${TEXT.slice(0, start)}${TEXT.slice(end)}`;
  const checks = { ok: false };
  const { session, files, text, state } = project({
    typeChecks: () => Promise.resolve({ ok: checks.ok, output: 'broken' }),
  });
  files.set(SETUP, SPLIT).set(OWN, MOVED);
  const workspace = withoutRemoval();
  const review = await reviewed(session, workspace);
  assertEquals(
    review.files.map(({ file, removed }) => [file, removed]),
    [
      ['example.ts', undefined],
      ['removal.ts', true],
    ],
  );

  // The project does not type-check without the file: the proof fails, and the file is back.
  const refused = (await session.save({ workspace, stamp: review.stamp })) as SaveRefusal;
  assertEquals([refused.reason, text(), files.get(OWN)], ['check', SPLIT, MOVED]);

  checks.ok = true;
  state.loads = startedHere(workspace);
  assertEquals(await session.save({ workspace, stamp: review.stamp }), {
    ok: true,
    written: ['example.ts', 'removal.ts'],
  });
  assertEquals([text().includes('removal.ts'), files.has(OWN)], [false, false]);
  state.loads = opened.workspace;
  assertEquals(await session.undo(), { ok: true, written: ['example.ts', 'removal.ts'] });
  assertEquals([text(), files.get(OWN)], [SPLIT, MOVED]);
});
