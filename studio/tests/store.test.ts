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
  restoreConversation,
  saveConversation,
} from '../ui/lib/studio-conversation.ts';
import { restoreStudio } from '../ui/lib/studio-restore.ts';
import { createStudioStore } from '../ui/lib/studio-store.ts';

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
  saveConversation(first.key, { blocks: [], session: {} } as never);
  assertEquals(restoreStudio().kind, 'discarded');
  assertEquals(sessionStorage.getItem(KEY), null);
  assertEquals(restoreConversation(first.key), undefined);
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

Deno.test('a draft kept by the one-agent studio opens as a workspace holding it', () => {
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
  assert(restoreConversation(agent.key));
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
  saveConversation('a', { blocks: [], session: { id: 'a' } } as never);
  saveConversation('b', { blocks: [], session: { id: 'b' } } as never);
  clearConversation('a');
  assertEquals(restoreConversation('a'), undefined);
  assert(restoreConversation('b'));
  clearConversation();
  assertEquals(restoreConversation('b'), undefined);
});
