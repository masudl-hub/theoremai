import { assertEquals } from '@std/assert';
import { createEditedSession, type EditedHost } from '../../studio/server/edited-session.ts';
import type { ProjectEdits } from '../../studio/server/edits.ts';
import registerExample from '../../studio/server/example.ts';
import { createStudioHandler, type StudioDescription } from '../../studio/server/handler.ts';
import type { SaveRefusal } from '../../studio/server/save-wire.ts';
import { type StudioWorkspace, setToolAllowed } from '../../studio/workspace.ts';

registerExample();
const opened: StudioDescription = await (
  await createStudioHandler({
    project: 'garden',
    pageOrigins: ['http://localhost:5174'],
    listenHost: '127.0.0.1:4983',
  })(new Request('http://127.0.0.1:4983/api/studio', { headers: { host: '127.0.0.1:4983' } }))
).json();

/** The example with `remove_plant` allowed, or not: the edit every test here runs. */
function edited(allowed = true): StudioWorkspace {
  const { workspace } = opened;
  const agent = workspace.agents[0];
  const removal = workspace.toolSpecs.find((tool) => tool.toolName === 'remove_plant');
  if (!agent || !removal) throw new Error('The example changed.');
  return setToolAllowed(workspace, agent.key, removal.key, allowed);
}

/** A project held in memory. Each edited load is the workspace `loads` holds then. */
function project(over: Partial<EditedHost<StudioWorkspace>> = {}) {
  const asked: ProjectEdits[] = [];
  const stopped: StudioWorkspace[] = [];
  const state = { loads: edited() };
  const session = createEditedSession<StudioWorkspace>({
    load: (edits) => {
      asked.push(edits);
      return Promise.resolve(state.loads);
    },
    stop: (loaded) => Promise.resolve(void stopped.push(loaded)),
    opened: (loaded) => loaded,
    ...over,
  });
  return { session, asked, stopped, state };
}

Deno.test('the edited load starts with what the builder changed, and is started once for the same edits', async () => {
  const { session, asked, stopped } = project();
  const first = await session.open(edited(), opened.workspace);
  assertEquals([first.ok, first.saved], [true, ['garden-desk']]);
  assertEquals(session.running(), edited());
  assertEquals(asked.length, 1);
  assertEquals(asked[0]?.subjects[0]?.of, 'garden-desk');
  assertEquals(await session.open(edited(), opened.workspace), first);
  assertEquals(asked.length, 1);
  assertEquals(stopped, []);
});

Deno.test('new edits end the load that held the old ones', async () => {
  const { session, asked, stopped, state } = project();
  const first = await session.open(edited(), opened.workspace);
  state.loads = edited(false);
  const second = await session.open(edited(false), opened.workspace);
  assertEquals([first.ok, second.ok], [true, true]);
  assertEquals(first.ok && second.ok && first.stamp !== second.stamp, true);
  assertEquals(asked.length, 2);
  assertEquals(stopped, [edited()]);
  assertEquals(session.running(), edited(false));
});

Deno.test('a load that is not what the builder is testing is ended and refused', async () => {
  const { session, stopped, state } = project();
  state.loads = opened.workspace;
  const answer = (await session.open(edited(), opened.workspace)) as SaveRefusal;
  assertEquals(
    [answer.ok, answer.reason, answer.detail],
    [false, 'differs', ['garden-desk', 'remove_plant']],
  );
  assertEquals(stopped, [opened.workspace]);
  assertEquals(session.running(), undefined);
});

Deno.test('a project that does not start with the edits is refused with what it printed', async () => {
  const { session } = project({
    load: () => Promise.reject(new Error('count_plants: bad schema')),
  });
  const answer = (await session.open(edited(), opened.workspace)) as SaveRefusal;
  assertEquals([answer.reason, answer.detail], ['load', ['count_plants: bad schema']]);
  assertEquals(session.running(), undefined);
});

Deno.test('closing ends the load, and the same edits start it again', async () => {
  const { session, asked, stopped } = project();
  await session.open(edited(), opened.workspace);
  await session.close();
  assertEquals(stopped, [edited()]);
  assertEquals(session.running(), undefined);
  await session.close();
  assertEquals(stopped.length, 1);
  await session.open(edited(), opened.workspace);
  assertEquals(asked.length, 2);
});
