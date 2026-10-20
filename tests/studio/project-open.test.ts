import { defineProvider, localProvider, openRouterProvider } from '../../mod.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';

registerFixtureProviders(defaultKernelScope);
// A provider under the project's own name, on a kernel definition.
defaultKernelScope.providers.register(openRouterProvider, { id: 'open-router', keySlot: 'slot_a' });
// A provider on a definition of the project's own.
defaultKernelScope.providers.register(defineProvider({ ...localProvider, id: 'house-chat' }), {
  id: 'house',
  connection: { baseUrl: 'https://house.example/v1' },
});

import { assert, assertEquals } from '@std/assert';
import { z } from 'zod';
import { defineProfile, registerProfile, registerStructured, registerTool } from '../../mod.ts';
import { compileStudio } from '../../studio/compile.ts';
import { compileWorkspace } from '../../studio/compile-workspace.ts';
import { newConversationKey } from '../../studio/conversation-key.ts';
import { createBlankDraft, setProfileType } from '../../studio/draft.ts';
import { ON_OWN_KEYS } from '../../studio/lent-keys.ts';
import { createStudioHandler, type StudioDescription } from '../../studio/server/handler.ts';
import { TEST_KEYS } from '../fixtures/lent-keys.ts';

const HOST = '127.0.0.1:4983';
const SCHEMA = { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] };

// An agent whose replies take a schema, a tool that runs it, and a profile that allows the tool.
const example = setProfileType(createBlankDraft(), 'text', TEST_KEYS);
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
  ON_OWN_KEYS,
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
    ...setProfileType(createBlankDraft(), 'speech', TEST_KEYS),
    identity: {
      ...example.identity,
      agentId: 'open-speaker',
      handle: 'speaker',
      profileType: 'speech',
    },
  },
  ON_OWN_KEYS,
);
assert(speaker.ok);
registerProfile(speaker.profile);

const handler = createStudioHandler({
  conversationKey: newConversationKey(),
  project: 'open',
  pageOrigins: [],
  listenHost: HOST,
});

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
  const compiled = compileWorkspace(workspace, ON_OWN_KEYS);
  assertEquals(compiled.ok ? [] : compiled.issues.map((issue) => issue.message), []);
});

Deno.test('a project opens with its own providers, each with the definition it is registered from', async () => {
  const request = new Request(`http://${HOST}/api/studio`, { headers: { host: HOST } });
  const { workspace }: StudioDescription = await (await handler(request)).json();
  const definitions = Object.fromEntries(
    workspace.providers.map(({ id, definition }) => [id, definition]),
  );
  assertEquals(definitions['open-router'], 'openrouter');
  assertEquals(definitions.local, 'local');
  assertEquals(definitions.house, 'house-chat');
});

Deno.test('a provider opens with its key slot and what it connects with', async () => {
  const request = new Request(`http://${HOST}/api/studio`, { headers: { host: HOST } });
  const { workspace }: StudioDescription = await (await handler(request)).json();
  const held = (id: string) => workspace.providers.find((provider) => provider.id === id);
  assertEquals(held('open-router'), {
    id: 'open-router',
    definition: 'openrouter',
    keySlot: 'slot_a',
  });
  assertEquals(held('local')?.connection, { baseUrl: 'http://localhost:11434/v1' });
  // What a project's own definition connects with stays with the project.
  assertEquals(held('house'), { id: 'house', definition: 'house-chat' });
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
