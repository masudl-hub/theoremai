import { assertEquals } from '@std/assert';
import { defaultKernelScope } from '../../mod.ts';
import { defaultToolSpec } from '../../studio/draft.ts';
import {
  changedSettings,
  editedQuestions,
  type ProjectEdits,
  registerEdits,
} from '../../studio/server/edits.ts';
import registerExample from '../../studio/server/example.ts';
import { createStudioHandler, type StudioDescription } from '../../studio/server/handler.ts';
import { projectDiffers, projectNames, saveSubjects } from '../../studio/server/save.ts';
import { type StudioWorkspace, setToolAllowed } from '../../studio/workspace.ts';

registerExample();

/** The project as the page opens it now. */
async function described(): Promise<StudioDescription> {
  const handler = createStudioHandler({
    project: 'example',
    pageOrigins: ['http://localhost:5174'],
    listenHost: '127.0.0.1:4983',
  });
  const answer = await handler(
    new Request('http://127.0.0.1:4983/api/studio', { headers: { host: '127.0.0.1:4983' } }),
  );
  return answer.json();
}

Deno.test('the settings that differ are named by path, and a list is one setting', () => {
  assertEquals(
    changedSettings(
      { id: 'desk', tools: { allow: ['a'] }, turn: { maxSteps: 4, note: 'x' } },
      { id: 'desk', tools: { allow: ['a', 'b'] }, turn: { maxSteps: 6 }, usage: true },
    ),
    [
      { path: ['tools', 'allow'], value: ['a', 'b'] },
      { path: ['turn', 'maxSteps'], value: 6 },
      { path: ['turn', 'note'] },
      { path: ['usage'], value: true },
    ],
  );
});

Deno.test("edits laid over the project load as what the builder tested, on the project's own handlers", async () => {
  const { workspace } = await described();
  const [agent] = workspace.agents;
  const removal = workspace.toolSpecs.find((tool) => tool.toolName === 'remove_plant');
  if (!agent || !removal) throw new Error('The example changed.');
  const count = defaultToolSpec({
    toolName: 'count_plants',
    description: 'Counts the plants in a bed.',
    inputJson: JSON.stringify({
      type: 'object',
      properties: {
        bed: { type: 'string', enum: ['north', 'south'] },
        since: { type: 'string', format: 'date' },
      },
      required: ['bed'],
      additionalProperties: false,
    }),
  });
  const edited: StudioWorkspace = [removal.key, count.key].reduce(
    (held, key) => setToolAllowed(held, agent.key, key, true),
    {
      ...workspace,
      toolSpecs: [
        ...workspace.toolSpecs.map((tool) =>
          tool.toolName === 'log_watering'
            ? { ...tool, description: 'Notes a watering.', access: 'destructive' as const }
            : tool,
        ),
        count,
      ],
    },
  );
  const subjects = saveSubjects(edited, projectNames(workspace));
  if (!subjects.ok) throw new Error(subjects.issues.join(' '));
  const handlerOf = (name: string) => {
    const tool = defaultKernelScope.tools.get(name);
    return tool?.type === 'function' ? tool.handler : undefined;
  };
  const own = handlerOf('log_watering');

  await registerEdits(defaultKernelScope, subjects);

  assertEquals(projectDiffers((await described()).workspace, edited), []);
  assertEquals(handlerOf('log_watering'), own);
  const allowed = defaultKernelScope.profiles.get('garden-desk');
  assertEquals('tools' in allowed && allowed.tools.allow, [
    'list_plants',
    'log_watering',
    'remove_plant',
    'count_plants',
  ]);
  // The new tool reads its request as the file Save writes would: a bed it does not know is refused.
  const added = defaultKernelScope.tools.get('count_plants');
  if (added?.type !== 'function') throw new Error('The new tool was not registered.');
  assertEquals(added.input.safeParse({ bed: 'north' }).success, true);
  assertEquals(added.input.safeParse({ bed: 'west' }).success, false);
});

Deno.test("a decision the setup does not name is asked the page's questions; the setup's own win", () => {
  const mood = { kind: 'choice', options: ['calm', 'tense'] };
  const page = { kind: 'choice', options: ['dry', 'wet'] };
  const edits = {
    subjects: [],
    added: {
      agents: [
        { agentId: 'new-check', questions: { soil: page } },
        { agentId: 'watering-check', questions: { soil: page } },
        { agentId: 'desk' },
      ],
      profiles: [],
      tools: [],
    },
  } as unknown as ProjectEdits;
  const named = { 'watering-check': { mood } } as unknown as Parameters<typeof editedQuestions>[1];
  assertEquals(editedQuestions(edits, named) as unknown, {
    'watering-check': { mood },
    'new-check': { soil: page },
  });
  assertEquals(editedQuestions(edits) as unknown, {
    'new-check': { soil: page },
    'watering-check': { soil: page },
  });
});
