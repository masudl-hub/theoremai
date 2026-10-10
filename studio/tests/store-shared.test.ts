import { assert, assertEquals } from '@std/assert';
import {
  addAgent,
  type AgentDraft,
  agentNodeId,
  createExampleDraft,
  sharedAsk,
  type SharedSites,
  type StudioWorkspace,
  workspaceFromDraft,
} from '../mod.ts';
import { createStudioStore } from '../ui/lib/studio-store.ts';

const example = createExampleDraft();
const named = (agentId: string) => ({ ...example, identity: { ...example.identity, agentId, handle: agentId } });

const place = (path: string, site: number, shared: boolean) => ({
  path: path.split('.'),
  site,
  shared,
  ...(shared ? { name: 'lite' } : {}),
  file: 'models.ts',
  line: 7,
});

/** `desk` and `shop` build `fast` with one helper, and `smart` with another. */
const SITES: SharedSites = {
  desk: [place('models.fast', 1, true), place('models.smart', 2, true)],
  shop: [place('models.fast', 1, true), place('models.smart', 2, true)],
};

/** A store on `desk`, `shop` and `yard`, with `desk` open. Each test has its own tab. */
function opened() {
  sessionStorage.clear();
  const workspace = ['shop', 'yard'].reduce((held, id) => addAgent(held, named(id)), workspaceFromDraft(named('desk')));
  const [desk, shop, yard] = workspace.agents;
  assert(desk && shop && yard);
  const store = createStudioStore({ workspace: { ...workspace, selected: agentNodeId(desk.key) }, revision: 0 }, SITES);
  return { store, desk, shop, yard };
}

const tokens = (workspace: StudioWorkspace, key: string, model = 'fast') =>
  workspace.agents.find((agent) => agent.key === key)?.modelBindings.find((each) => each.modelId === model)
    ?.maxOutputTokens;

/** `key`'s model `model` given `maxOutputTokens`. */
const capped = (key: string, maxOutputTokens: number, model = 'fast') => (workspace: StudioWorkspace) => ({
  ...workspace,
  agents: workspace.agents.map((agent): AgentDraft =>
    agent.key !== key ? agent : {
      ...agent,
      modelBindings: agent.modelBindings.map((each) => (each.modelId === model ? { ...each, maxOutputTokens } : each)),
    }
  ),
});

Deno.test('a change to a shared value waits for the builder, then is made on each agent that shares it', () => {
  const { store, desk, shop, yard } = opened();
  const before = store.getWorkspace();
  assertEquals(store.update(capped(desk.key, 4096)), before);
  assertEquals(store.getRevision(), 0);
  const reach = store.getPending();
  assertEquals(reach?.agents, [shop.key]);
  assert(reach);
  assertEquals(sharedAsk(reach, before), {
    title: 'Change it for 1 other profile?',
    line: 'lite · models.ts:7 sets this once. shop uses it too, and will change with it.',
  });

  store.confirmShared();
  assertEquals(store.getPending(), undefined);
  assertEquals(store.getRevision(), 1);
  const after = store.getWorkspace();
  assertEquals([desk, shop, yard].map((agent) => tokens(after, agent.key)), [4096, 4096, null]);

  // The same value is not asked about again while the same node is open. Another one is.
  store.update(capped(desk.key, 2048));
  assertEquals([store.getPending(), tokens(store.getWorkspace(), shop.key)], [undefined, 2048]);
  store.update(capped(desk.key, 512, 'smart'));
  assertEquals(store.getPending()?.sites, [2]);
  store.cancelShared();
  assertEquals([store.getPending(), tokens(store.getWorkspace(), desk.key, 'smart')], [undefined, null]);
  // Opening another node asks again.
  store.select(agentNodeId(shop.key));
  store.update(capped(shop.key, 1024));
  assertEquals(store.getPending()?.agents, [desk.key]);
  assertEquals(tokens(store.getWorkspace(), shop.key), 2048);
});

Deno.test('the builder can say not to be asked again in this tab', () => {
  const { store, desk, shop } = opened();
  store.update(capped(desk.key, 4096));
  store.confirmShared(true);
  store.select(agentNodeId(shop.key));
  store.update(capped(shop.key, 1024, 'smart'));
  assertEquals(store.getPending(), undefined);
  assertEquals(tokens(store.getWorkspace(), desk.key, 'smart'), 1024);
});

Deno.test('a change that reaches no other agent, and a change by th30, are made at once', () => {
  const { store, desk, shop, yard } = opened();
  store.update(capped(yard.key, 4096));
  assertEquals([store.getPending(), tokens(store.getWorkspace(), yard.key)], [undefined, 4096]);
  store.update(capped(desk.key, 4096), 'th30');
  assertEquals([store.getPending(), tokens(store.getWorkspace(), shop.key)], [undefined, 4096]);
});
