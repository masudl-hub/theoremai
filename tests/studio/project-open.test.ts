import { defineProvider } from '../../src/kernel/provider-contract.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { openAIChat, openRouterAdapter } from '../../src/providers/adapters.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';

registerFixtureProviders(defaultKernelScope);
// A provider under the project's own name, on a first-party adapter.
defaultKernelScope.providers.register(
  defineProvider({
    id: 'open-router',
    connection: {},
    keySlot: 'slot_a',
    adapter: openRouterAdapter(),
  }),
);
// A provider on an adapter of the project's own.
defaultKernelScope.providers.register(
  defineProvider({
    id: 'house',
    connection: { baseURL: 'https://house.example/v1' },
    adapter: { ...openAIChat(), id: 'house-chat' },
  }),
);

import { assert, assertEquals } from '@std/assert';
import { z } from 'zod';
import { defineProfile, registerProfile, registerStructured, registerTool } from '../../mod.ts';
import { compileStudio } from '../../studio/compile.ts';
import { compileWorkspace } from '../../studio/compile-workspace.ts';
import { createBlankDraft, setProfileType } from '../../studio/draft.ts';
import { createStudioHandler, type StudioDescription } from '../../studio/server/handler.ts';

const HOST = '127.0.0.1:4983';
const SCHEMA = { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] };

// An agent whose replies take a schema, a tool that runs it, and a profile that allows the tool.
const example = setProfileType(createBlankDraft(), 'text');
const thinker = compileStudio(
  {
    ...example,
    identity: { ...example.identity, agentId: 'open-thinker', handle: 'thinker' },
    included: [...example.included, 'outputs'],
    outputs: {
      ...example.outputs,
      mode: 'structured',
      schemaId: 'open.note',
      schemaJson: JSON.stringify(SCHEMA),
    },
  },
  'byok',
);
assert(thinker.ok && thinker.structured);
registerStructured(thinker.structured.id, thinker.structured.spec);
registerProfile(thinker.profile);
registerTool({
  type: 'agent',
  name: 'open_think',
  description: 'Thinks it through.',
  profile: 'open-thinker',
  access: 'read-only',
  category: 'studio',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
});
registerProfile(defineProfile({ type: 'host', id: 'open-desk', tools: { allow: ['open_think'] } }));
// A second tool, and a profile that allows the two in the other order than they were registered in.
registerTool({
  type: 'http',
  name: 'open_fetch',
  description: 'Fetches a page.',
  method: 'GET',
  endpoint: 'https://example.com/page',
  input: z.object({}),
  output: z.object({ page: z.string() }),
  access: 'read-only',
  category: 'studio',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
});
registerProfile(
  defineProfile({ type: 'host', id: 'open-shelf', tools: { allow: ['open_fetch', 'open_think'] } }),
);
// A profile of a type that takes no tools.
const speaker = compileStudio(
  {
    ...setProfileType(createBlankDraft(), 'speech'),
    identity: {
      ...example.identity,
      agentId: 'open-speaker',
      handle: 'speaker',
      profileType: 'speech',
    },
  },
  'byok',
);
assert(speaker.ok);
registerProfile(speaker.profile);

const handler = createStudioHandler({ project: 'open', pageOrigins: [], listenHost: HOST });

Deno.test('a project opens with the schema its replies take and the agent each agent tool runs', async () => {
  const request = new Request(`http://${HOST}/api/studio`, { headers: { host: HOST } });
  const { workspace }: StudioDescription = await (await handler(request)).json();
  const agent = workspace.agents.find((held) => held.identity.agentId === 'open-thinker');
  assert(agent);
  assertEquals(JSON.parse(agent.outputs.schemaJson), SCHEMA);
  const tool = workspace.toolSpecs.find((held) => held.toolName === 'open_think');
  assert(tool);
  assertEquals([tool.agentKey, workspace.starts.tools[tool.key]], [agent.key, tool]);
  // Nothing the files hold is missing: the project compiles as it opens, so it can be saved.
  const compiled = compileWorkspace(workspace, 'byok');
  assertEquals(compiled.ok ? [] : compiled.issues.map((issue) => issue.message), []);
});

Deno.test('a project opens with its own providers, each with the adapter it is defined on', async () => {
  const request = new Request(`http://${HOST}/api/studio`, { headers: { host: HOST } });
  const { workspace }: StudioDescription = await (await handler(request)).json();
  const adapters = Object.fromEntries(workspace.providers.map(({ id, adapter }) => [id, adapter]));
  assertEquals(adapters['open-router'], 'openrouter');
  assertEquals(adapters.local, 'openai-chat');
});

Deno.test('a provider opens with its key slot and what it connects with', async () => {
  const request = new Request(`http://${HOST}/api/studio`, { headers: { host: HOST } });
  const { workspace }: StudioDescription = await (await handler(request)).json();
  const held = (id: string) => workspace.providers.find((provider) => provider.id === id);
  assertEquals(held('open-router'), {
    id: 'open-router',
    adapter: 'openrouter',
    keySlot: 'slot_a',
  });
  assertEquals(held('local')?.connection, { baseURL: 'http://localhost:11434/v1' });
  // What a project's own adapter connects with stays with the project.
  assertEquals(held('house'), { id: 'house', adapter: 'house-chat' });
});

Deno.test('a profile with no tools opens allowing none, whatever the project registers', async () => {
  const request = new Request(`http://${HOST}/api/studio`, { headers: { host: HOST } });
  const { workspace }: StudioDescription = await (await handler(request)).json();
  const agent = workspace.agents.find((held) => held.identity.agentId === 'open-speaker');
  assert(agent);
  assertEquals(agent.tools.allow, []);
});

Deno.test('a project opens as the profiles it registered, but for what studio policy sets', async () => {
  const request = new Request(`http://${HOST}/api/studio`, { headers: { host: HOST } });
  const { differences }: StudioDescription = await (await handler(request)).json();
  assertEquals(differences, undefined);
});
