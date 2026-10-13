import { defineProvider } from '../../src/kernel/provider-contract.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { openRouterAdapter } from '../../src/providers/adapters.ts';
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

import { assert, assertEquals } from '@std/assert';
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
