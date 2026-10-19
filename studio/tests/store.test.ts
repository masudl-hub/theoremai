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

const KEY = 'theorem.studio.v2';
const V1_KEY = 'theorem.studio.v1';

function keep(workspace: unknown) {
  sessionStorage.setItem(
    KEY,
    JSON.stringify({ v: STUDIO_WORKSPACE_VERSION, workspace, revision: 4 }),
  );
}

function keepV1(draft: unknown) {
  sessionStorage.setItem(
    V1_KEY,
    JSON.stringify({ v: 1, draft, revision: 4, selectedId: 'models' }),
  );
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
  sessionStorage.clear();
});

Deno.test('a workspace with an agent kept before the draft grew a section is set aside', () => {
  const workspace = twoAgents();
  const [first, second] = workspace.agents;
  assert(first && second);
  const { allow: _dropped, ...olderGuardrails } = second.guardrails;
  keep({ ...workspace, agents: [first, { ...second, guardrails: olderGuardrails }] });
  saveConversation(first.key, 'page', 'sealed-ref');
  assertEquals(restoreStudio().kind, 'discarded');
  assertEquals(sessionStorage.getItem(KEY), null);
  assertEquals(restoreConversation(first.key, 'page'), undefined);
});

Deno.test('an agent kept with a field of another type is set aside', () => {
  const workspace = twoAgents();
  const [first] = workspace.agents;
  assert(first);
  const identity = { ...first.identity, system: [{ text: 'x', private: true }] };
  keep({ ...workspace, agents: [{ ...first, identity }] });
  assertEquals(restoreStudio().kind, 'discarded');
  sessionStorage.clear();
});

Deno.test('a draft kept by the one-agent studio opens as a workspace holding it, without its conversation', () => {
  const draft = createExampleDraft();
  keepV1(draft);
  sessionStorage.setItem('theorem.studio.v1.chat', JSON.stringify({ blocks: [], session: {} }));
  const restored = restoreStudio();
  assertEquals(restored.kind, 'restored');
  if (restored.kind !== 'restored') return;
  const { workspace, revision } = restored.value;
  const [agent] = workspace.agents;
  assertEquals(revision, 4);
  assertEquals(agent?.identity.agentId, 'travel.concierge');
  assertEquals(
    agent.tools.allow,
    draft.toolSpecs.map((tool) => tool.key),
  );
  assertEquals(workspace.selected, agentNodeId(agent.key, 'models'));
  // It was kept whole, before conversations were sealed: nothing can resume it.
  assertEquals(restoreConversation(agent.key, 'page'), undefined);
  assertEquals(sessionStorage.getItem('theorem.studio.v1.chat'), null);
  assertEquals(sessionStorage.getItem(V1_KEY), null);
  sessionStorage.clear();
});

Deno.test('a one-agent draft in an older shape is set aside', () => {
  const blank = createBlankDraft();
  const { allow: _dropped, ...olderGuardrails } = blank.guardrails;
  keepV1({ ...blank, guardrails: olderGuardrails });
  assertEquals(restoreStudio().kind, 'discarded');
  assertEquals(sessionStorage.getItem(V1_KEY), null);
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
  sessionStorage.clear();
});

Deno.test('a conversation kept whole, before refs, is forgotten on restore', () => {
  sessionStorage.setItem('theorem.studio.v2.chat:a', JSON.stringify({ blocks: [], session: {} }));
  assertEquals(restoreConversation('a', 'page'), undefined);
  assertEquals(sessionStorage.getItem('theorem.studio.v2.chat:a'), null);
});

Deno.test("a tab's new key forgets the refs its page runs sealed with the last one", () => {
  saveConversation('a', 'page', 'ref-a');
  saveConversation('b', 'demo', 'ref-b');
  const key = pageConversationKey();
  assertEquals(pageConversationKey(), key);
  assertEquals(restoreConversation('a', 'page'), undefined);
  assertEquals(restoreConversation('b', 'demo'), 'ref-b');
  sessionStorage.clear();
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
