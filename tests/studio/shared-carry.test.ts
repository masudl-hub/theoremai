import { assert, assertEquals } from '@std/assert';
import { createExampleDraft } from '../../studio/mod.ts';
import type { SettingSite } from '../../studio/server/save-wire.ts';
import { type SharedSites, sharedSnapshot, withSharedCarry } from '../../studio/shared-carry.ts';
import {
  type AgentDraft,
  addAgent,
  type StudioWorkspace,
  workspaceFromDraft,
} from '../../studio/workspace.ts';

const example = createExampleDraft();
const named = (agentId: string) => ({
  ...example,
  identity: { ...example.identity, agentId, handle: agentId },
});

/** Three agents as the example is: `desk`, `shop` and `yard`. */
function opened(): StudioWorkspace {
  return ['shop', 'yard'].reduce(
    (workspace, id) => addAgent(workspace, named(id)),
    workspaceFromDraft(named('desk')),
  );
}

const site = (path: string, at: number, shared = true, name?: string): SettingSite => ({
  path: path ? path.split('.') : [],
  site: at,
  shared,
  ...(name ? { name } : {}),
  file: 'models.ts',
  line: at,
});

const agent = (workspace: StudioWorkspace, id: string): AgentDraft => {
  const found = workspace.agents.find((each) => each.identity.agentId === id);
  if (!found) throw new Error(`No agent ${id}.`);
  return found;
};

const edit = (
  workspace: StudioWorkspace,
  id: string,
  change: (agent: AgentDraft) => AgentDraft,
) => ({
  ...workspace,
  agents: workspace.agents.map((each) => (each.identity.agentId === id ? change(each) : each)),
});

/** `agent` with its model `model` changed. */
const bound =
  (model: string, change: Partial<AgentDraft['modelBindings'][number]>) => (agent: AgentDraft) => ({
    ...agent,
    modelBindings: agent.modelBindings.map((each) =>
      each.modelId === model ? { ...each, ...change } : each,
    ),
  });

const model = (workspace: StudioWorkspace, id: string, name: string) =>
  agent(workspace, id).modelBindings.find((each) => each.modelId === name);

function carry(before: StudioWorkspace, after: StudioWorkspace, sites: SharedSites) {
  const good = sharedSnapshot(before);
  assert(good);
  return withSharedCarry(good, after, sites);
}

/** `desk` and `shop` build `fast` with one helper, which `shop` uses for `smart` too. Each sets its own summaries. */
const HELPED: SharedSites = {
  desk: [site('models.fast', 1, true, 'lite'), site('models.fast.summaries', 2, false)],
  shop: [
    site('models.fast', 1, true, 'lite'),
    site('models.fast.summaries', 3, false),
    site('models.smart', 1, true, 'lite'),
    site('models.smart.summaries', 4, false),
  ],
};

Deno.test('a change to what a helper writes is made on each agent and each model that uses it', () => {
  const before = opened();
  const after = edit(before, 'desk', bound('fast', { maxOutputTokens: 4096 }));
  const { workspace, reach } = carry(before, after, HELPED);
  assertEquals(model(workspace, 'shop', 'fast')?.maxOutputTokens, 4096);
  assertEquals(model(workspace, 'shop', 'smart')?.maxOutputTokens, 4096);
  // What the helper does not write for it stays the model's own.
  assertEquals(model(workspace, 'shop', 'smart')?.apiId, model(before, 'shop', 'smart')?.apiId);
  assertEquals(agent(workspace, 'yard'), agent(before, 'yard'));
  assertEquals(reach, {
    sites: [1],
    name: 'lite',
    file: 'models.ts',
    line: 1,
    from: agent(before, 'desk').key,
    agents: [agent(before, 'shop').key],
  });
});

Deno.test('a change to what an agent sets apart inside a shared value stays its own', () => {
  const before = opened();
  const after = edit(before, 'desk', bound('fast', { summaries: false }));
  const made = carry(before, after, HELPED);
  assertEquals(made.workspace === after, true);
  assertEquals(made.reach, undefined);
  assertEquals(
    carry(before, edit(before, 'yard', bound('fast', { maxOutputTokens: 1 })), HELPED).reach,
    undefined,
  );
});

Deno.test('a change is read against the last workspace that compiled', () => {
  const before = opened();
  const good = sharedSnapshot(before);
  assert(good);
  // Mid-edit: the workspace does not compile, so nothing is carried and nothing is forgotten.
  const cleared = edit(before, 'desk', bound('fast', { apiId: '' }));
  const first = withSharedCarry(good, cleared, HELPED);
  assertEquals(
    [first.workspace === cleared, first.snapshot, first.reach],
    [true, undefined, undefined],
  );
  const typed = edit(cleared, 'desk', bound('fast', { apiId: 'gemini-3.5-flash-lite' }));
  const second = withSharedCarry(good, typed, HELPED);
  assertEquals(model(second.workspace, 'shop', 'fast')?.apiId, 'gemini-3.5-flash-lite');
  assertEquals(second.reach?.agents, [agent(before, 'shop').key]);
  // The next change is read against it: nothing is owed twice.
  assert(second.snapshot);
  assertEquals(withSharedCarry(second.snapshot, second.workspace, HELPED).reach, undefined);
});

/** A function makes `desk` and `shop`: the whole of each is one value, but for its id. */
const MADE: SharedSites = {
  desk: [site('', 1, true, 'brain'), site('id', 2, false)],
  shop: [site('', 1, true, 'brain'), site('id', 3, false)],
};

Deno.test('a change to an agent a function makes is made on each agent the function makes', () => {
  const before = opened();
  const steps = (maxSteps: number) => (each: AgentDraft) => ({
    ...each,
    models: { ...each.models, maxSteps },
  });
  const { workspace, reach } = carry(before, edit(before, 'desk', steps(3)), MADE);
  assertEquals(agent(workspace, 'shop').models.maxSteps, 3);
  assertEquals(agent(workspace, 'yard').models.maxSteps, agent(before, 'yard').models.maxSteps);
  assertEquals(reach?.name, 'brain');

  // A model the function writes is added to each, and taken from each.
  const added = edit(before, 'desk', (each) => {
    const [binding] = each.modelBindings;
    assert(binding);
    return {
      ...each,
      modelBindings: [
        ...each.modelBindings,
        { ...binding, key: 'model-00000000', modelId: 'extra' },
      ],
    };
  });
  const more = carry(before, added, MADE);
  assertEquals(model(more.workspace, 'shop', 'extra')?.apiId, model(before, 'desk', 'fast')?.apiId);
  assert(model(more.workspace, 'shop', 'extra')?.key !== 'model-00000000');
  assert(more.snapshot);
  const taken = edit(more.workspace, 'shop', (each) => ({
    ...each,
    modelBindings: each.modelBindings.filter((binding) => binding.modelId !== 'extra'),
  }));
  assertEquals(
    model(withSharedCarry(more.snapshot, taken, MADE).workspace, 'desk', 'extra'),
    undefined,
  );
});

Deno.test('an agent that would not hold the value alone is left as it is', () => {
  const before = opened();
  // `shop` holds its efforts another way, so the list cannot be carried without changing what is its own.
  const efforts = (level: 'low' | 'medium') => [
    { alias: 'fast', level },
    { alias: 'deep', level: 'high' as const },
  ];
  const apart = edit(before, 'shop', bound('fast', { efforts: efforts('low') }));
  const sites: SharedSites = {
    desk: [site('models.fast', 1, true, 'lite')],
    shop: [site('models.fast', 1, true, 'lite'), site('models.fast.efforts', 2, false)],
  };
  const after = edit(apart, 'desk', bound('fast', { efforts: efforts('medium') }));
  const made = carry(apart, after, sites);
  assertEquals(agent(made.workspace, 'shop'), agent(apart, 'shop'));
  assertEquals(made.reach, undefined);
});
