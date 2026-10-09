import { assertEquals } from '@std/assert';
import registerExample from '../../studio/server/example.ts';
import { createStudioHandler, type StudioDescription } from '../../studio/server/handler.ts';
import {
  answerSave,
  createSaveSession,
  isSaveRequest,
  type SaveHost,
} from '../../studio/server/save-session.ts';
import type { SaveDone, SaveRefusal, SaveReview } from '../../studio/server/save-wire.ts';
import { type StudioWorkspace, setToolAllowed, startedHere } from '../../studio/workspace.ts';

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

Deno.test('a change Save cannot write turns Save off, and a workspace it cannot read is refused', async () => {
  const { session, text } = project();
  const workspace = edited();
  const [agent] = workspace.agents;
  if (!agent) throw new Error('The example changed.');
  const second = {
    ...agent,
    key: 'second',
    identity: { ...agent.identity, agentId: 'second-desk' },
  };
  const added = { ...workspace, agents: [agent, second] };
  const review = await reviewed(session, added);
  assertEquals(
    review.changes.map(({ of, status }) => [of, status]),
    [
      ['second-desk', 'new'],
      ['garden-desk', 'written'],
    ],
  );
  assertEquals(review.writable, false);
  assertEquals(
    ((await session.save({ workspace: added, stamp: review.stamp })) as SaveRefusal).reason,
    'unwritable',
  );
  assertEquals(text(), TEXT);

  const broken = {
    ...workspace,
    agents: [{ ...agent, identity: { ...agent.identity, agentId: '' } }],
  };
  assertEquals(((await session.save({ workspace: broken })) as SaveRefusal).reason, 'issues');
  assertEquals(isSaveRequest({ workspace }), true);
  assertEquals([isSaveRequest(null), isSaveRequest({ workspace: { agents: [] } })], [false, false]);
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
