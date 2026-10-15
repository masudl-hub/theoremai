import { assertEquals } from '@std/assert';
import { defaultKernelScope, openAIChat } from '../../mod.ts';
import { newConversationKey } from '../../studio/conversation-key.ts';
import { defaultToolSpec } from '../../studio/draft.ts';
import { providerDefinition, withSupport } from '../../studio/providers.ts';
import {
  changedSettings,
  editedQuestions,
  type ProjectEdits,
  registerEdits,
} from '../../studio/server/edits.ts';
import registerExample from '../../studio/server/example.ts';
import { createStudioHandler, type StudioDescription } from '../../studio/server/handler.ts';
import {
  projectDiffers,
  projectNames,
  providerSettings,
  saveSubjects,
} from '../../studio/server/save.ts';
import { type StudioWorkspace, setToolAllowed, withProvider } from '../../studio/workspace.ts';

registerExample();

/** The project as the page opens it now. */
async function described(): Promise<StudioDescription> {
  const handler = createStudioHandler({
    conversationKey: newConversationKey(),
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

Deno.test('a provider the builder changed runs as edited, with everything else as the project registered it', async () => {
  const registered = defaultKernelScope.providers.register({
    id: 'house',
    connection: { baseURL: 'https://house.example/v1' },
    keySlot: 'team',
    adapter: openAIChat(),
  });
  try {
    const { workspace } = await described();
    const provider = workspace.providers.find((each) => each.id === 'house');
    if (!provider) throw new Error('The provider did not open.');
    const edited = withProvider(workspace, {
      ...provider,
      connection: { baseURL: 'https://other.example/v1' },
      keySlot: undefined,
      fallbackKeySlot: 'spare',
    });
    // The example's models name providers this project does not register: only the provider is read.
    const subjects = {
      subjects: [
        {
          kind: 'provider' as const,
          of: 'house',
          before: providerSettings(provider),
          after: providerSettings(providerOf(edited)),
        },
      ],
      added: { agents: [], profiles: [], tools: [], providers: [] },
    };
    await registerEdits(defaultKernelScope, subjects);
    const now = defaultKernelScope.providers.require('house');
    assertEquals([now.keySlot, now.fallbackKeySlot], [undefined, 'spare']);
    assertEquals(now.adapter, registered.adapter);
    assertEquals(now.connection, { baseURL: 'https://other.example/v1' });
    assertEquals(providerOf((await described()).workspace), providerOf(edited));
  } finally {
    defaultKernelScope.providers.reset();
  }
});

Deno.test('a provider the builder added is registered for the run', async () => {
  try {
    const added = {
      agents: [],
      profiles: [],
      tools: [],
      providers: [{ id: 'spare-house', adapter: 'openrouter', connection: {}, keySlot: 'spare' }],
    };
    await registerEdits(defaultKernelScope, { subjects: [], added });
    const now = defaultKernelScope.providers.require('spare-house');
    assertEquals([now.adapter.id, now.keySlot], ['openrouter', 'spare']);
  } finally {
    defaultKernelScope.providers.reset();
  }
});

Deno.test('a provider the builder moved to another adapter runs on it', async () => {
  defaultKernelScope.providers.register(
    providerDefinition({
      id: 'moved',
      adapter: 'openai-chat',
      connection: { baseURL: 'https://one.example/v1' },
      keySlot: 'team',
    }),
  );
  try {
    const before = {
      adapter: 'openai-chat',
      connection: { baseURL: 'https://one.example/v1' },
      keySlot: 'team',
    };
    await registerEdits(defaultKernelScope, {
      subjects: [
        {
          kind: 'provider',
          of: 'moved',
          before,
          after: { adapter: 'openrouter', connection: {}, keySlot: 'team' },
        },
      ],
      added: { agents: [], profiles: [], tools: [], providers: [] },
    });
    const now = defaultKernelScope.providers.require('moved');
    assertEquals([now.adapter.id, now.connection, now.keySlot], ['openrouter', {}, 'team']);
  } finally {
    defaultKernelScope.providers.reset();
  }
});

Deno.test('a provider told its models take tools runs on an adapter told so', async () => {
  defaultKernelScope.providers.register(
    providerDefinition({
      id: 'told',
      adapter: 'openai-chat',
      connection: { baseURL: 'https://one.example/v1' },
    }),
  );
  try {
    const { workspace } = await described();
    const provider = workspace.providers.find((each) => each.id === 'told');
    if (!provider) throw new Error('The provider did not open.');
    // Told nothing, it opens with nothing: its adapter's defaults.
    assertEquals(provider.capabilities, undefined);
    const after = withSupport(provider, { clientTools: 'supported' });
    await registerEdits(defaultKernelScope, {
      subjects: [
        {
          kind: 'provider',
          of: 'told',
          before: providerSettings(provider),
          after: providerSettings(after),
        },
      ],
      added: { agents: [], profiles: [], tools: [], providers: [] },
    });
    const now = defaultKernelScope.providers.require('told');
    const support = now.adapter.capabilities({
      apiId: 'any',
      connection: now.connection,
      providerOptions: {},
    });
    assertEquals(support.features.clientTools, 'supported');
    assertEquals(now.connection, { baseURL: 'https://one.example/v1' });
  } finally {
    defaultKernelScope.providers.reset();
  }
});

const providerOf = (workspace: StudioWorkspace) => {
  const held = workspace.providers.find((each) => each.id === 'house');
  if (!held) throw new Error('The provider did not open.');
  return JSON.parse(JSON.stringify(held));
};
