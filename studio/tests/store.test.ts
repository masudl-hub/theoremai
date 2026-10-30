import { assert, assertEquals } from '@std/assert';
import {
  addAgent,
  agentNodeId,
  createBlankDraft,
  createExampleDraft,
  STUDIO_WORKSPACE_VERSION,
  type StudioWorkspace,
  workspaceFromDraft,
} from '../mod.ts';
import {
  clearConversation,
  pageConversationKey,
  restoreConversation,
  saveConversation,
} from '../ui/lib/studio-conversation.ts';
import { restoreStudio } from '../ui/lib/studio-restore.ts';
import { createStudioStore, keptWorkspace } from '../ui/lib/studio-store.ts';
import { tab } from './tab.ts';

const KEY = 'theorem.studio.v2';

function keep(workspace: unknown) {
  tab.setItem(KEY, JSON.stringify({ v: STUDIO_WORKSPACE_VERSION, workspace, revision: 4 }));
}

/** A workspace of the example and a blank agent, the example open. */
function twoAgents(): StudioWorkspace {
  const workspace = addAgent(workspaceFromDraft(createExampleDraft()), createBlankDraft());
  return { ...workspace, selected: agentNodeId(workspace.agents[0]?.key ?? '') };
}

Deno.test('a kept workspace in the current shape comes back', () => {
  keep(twoAgents());
  const restored = restoreStudio();
  assertEquals(restored.kind, 'restored');
  assertEquals(restored.kind === 'restored' && restored.value.workspace.agents.length, 2);
  tab.clear();
});

Deno.test('an agent whose trace scrub names the sides comes back', () => {
  const workspace = twoAgents();
  const [first, second] = workspace.agents;
  assert(first && second);
  const scrub = { ...first.observability.scrub, sensitive: { theorem: true, host: false } };
  const observability = { ...first.observability, scrub };
  keep({ ...workspace, agents: [{ ...first, observability }, second] });
  const restored = restoreStudio();
  assertEquals(restored.kind, 'restored');
  assertEquals(
    restored.kind === 'restored' &&
      restored.value.workspace.agents[0]?.observability.scrub.sensitive,
    { theorem: true, host: false },
  );
  tab.clear();
});

Deno.test('a workspace with an agent kept before the draft grew a section is set aside', () => {
  const workspace = twoAgents();
  const [first, second] = workspace.agents;
  assert(first && second);
  const { allow: _dropped, ...olderGuardrails } = second.guardrails;
  keep({ ...workspace, agents: [first, { ...second, guardrails: olderGuardrails }] });
  saveConversation(first.key, 'page', 'sealed-ref');
  assertEquals(restoreStudio().kind, 'discarded');
  assertEquals(tab.getItem(KEY), null);
  assertEquals(restoreConversation(first.key, 'page'), undefined);
});

Deno.test('an agent kept with a field of another type is set aside', () => {
  const workspace = twoAgents();
  const [first] = workspace.agents;
  assert(first);
  const identity = { ...first.identity, system: [{ text: 'x', private: true }] };
  keep({ ...workspace, agents: [{ ...first, identity }] });
  assertEquals(restoreStudio().kind, 'discarded');
  tab.clear();
});

Deno.test('the store edits the open agent, with the whole library as its tools', () => {
  const workspace = twoAgents();
  const [concierge, blank] = workspace.agents;
  assert(concierge && blank);
  const store = createStudioStore({ workspace, revision: 0 });
  assertEquals(store.getFocus(), concierge.key);
  store.select(agentNodeId(blank.key, 'models'));
  assertEquals(store.getFocus(), blank.key);
  assertEquals(store.getRevision(), 0, 'opening a node is not an edit');
  assertEquals(store.getDraft().toolSpecs.length, workspace.toolSpecs.length);
  store.updateDraft((draft) => ({ ...draft, identity: { ...draft.identity, agentId: 'helper' } }));
  const [, edited] = store.getWorkspace().agents;
  assertEquals(edited?.identity.agentId, 'helper');
  assertEquals(edited.tools.allow, [], 'the blank agent still allows none of the tools');
  assertEquals(store.getWorkspace().agents[0], concierge);
  assertEquals(store.changesSince(0)[0]?.sections, ['identity']);
});

Deno.test('a library tool keeps the agent that was open', () => {
  const workspace = twoAgents();
  const [, blank] = workspace.agents;
  const tool = workspace.toolSpecs[0];
  assert(blank && tool);
  const store = createStudioStore({ workspace, revision: 0 });
  store.select(agentNodeId(blank.key));
  store.select(`toolSpec:${tool.key}`);
  assertEquals(store.getFocus(), blank.key);
  assertEquals(store.getWorkspace().chatWith, blank.key);
});

Deno.test('opening an agent in the tree is the agent the preview talks to', () => {
  const workspace = twoAgents();
  const [concierge, blank] = workspace.agents;
  assert(concierge && blank);
  const store = createStudioStore({ workspace, revision: 0 });
  assertEquals(store.getWorkspace().chatWith, concierge.key);
  store.select(agentNodeId(blank.key, 'models'));
  assertEquals(store.getWorkspace().chatWith, blank.key);
  assertEquals(store.getRevision(), 0, 'it is not an edit');
  store.select(agentNodeId(concierge.key));
  assertEquals(store.getWorkspace().chatWith, concierge.key);
});

Deno.test('an agent added and opened is the agent the preview talks to', () => {
  const workspace = twoAgents();
  const store = createStudioStore({ workspace, revision: 0 });
  store.update(addAgent(store.getWorkspace(), createBlankDraft()));
  const added = store.getWorkspace().agents.at(-1);
  assert(added);
  store.select(store.getWorkspace().selected);
  assertEquals(store.getWorkspace().chatWith, added.key);
});

Deno.test('each agent keeps a conversation of its own', () => {
  saveConversation('a', 'page', 'ref-a');
  saveConversation('b', 'page', 'ref-b');
  clearConversation('a');
  assertEquals(restoreConversation('a', 'page'), undefined);
  assertEquals(restoreConversation('b', 'page'), 'ref-b');
  clearConversation();
  assertEquals(restoreConversation('b', 'page'), undefined);
});

Deno.test('a kept conversation is offered only to runs its sealer opens', () => {
  saveConversation('a', 'demo', 'ref-a');
  assertEquals(restoreConversation('a', 'page'), undefined);
  assertEquals(restoreConversation('a', 'demo'), 'ref-a');
  tab.clear();
});

Deno.test('a conversation kept whole, before refs, is forgotten on restore', () => {
  tab.setItem('theorem.studio.v2.chat:a', JSON.stringify({ blocks: [], session: {} }));
  assertEquals(restoreConversation('a', 'page'), undefined);
  assertEquals(tab.getItem('theorem.studio.v2.chat:a'), null);
});

Deno.test("a tab's new key forgets the refs its page runs sealed with the last one", () => {
  saveConversation('a', 'page', 'ref-a');
  saveConversation('b', 'demo', 'ref-b');
  const key = pageConversationKey();
  assertEquals(pageConversationKey(), key);
  assertEquals(restoreConversation('a', 'page'), undefined);
  assertEquals(restoreConversation('b', 'demo'), 'ref-b');
  tab.clear();
});

Deno.test('headers that are not a JSON object yet are not kept; the headers as they started are', () => {
  const example = createExampleDraft();
  const started = '{"Accept":"application/json","X-Api-Key":"s3cr3t"}';
  const workspace = workspaceFromDraft({
    ...example,
    toolSpecs: example.toolSpecs.map((tool, index) =>
      index === 0 ? { ...tool, headersJson: started } : tool,
    ),
  });
  const [tool] = workspace.toolSpecs;
  assert(tool);
  const typing = '{"Accept":"application/json","X-Keyboard":"s3cr3';
  const kept = keptWorkspace({
    ...workspace,
    toolSpecs: workspace.toolSpecs.map((each) =>
      each.key === tool.key ? { ...each, headersJson: typing } : each,
    ),
  });
  const shown = '{"Accept":"application/json","X-Api-Key":"••••"}';
  assertEquals(kept.toolSpecs[0]?.headersJson, shown);
  assertEquals(kept.starts.tools[tool.key]?.headersJson, shown);
});
