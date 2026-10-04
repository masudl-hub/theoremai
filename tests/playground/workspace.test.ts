import { assert, assertEquals } from '@std/assert';
import {
  addAgent,
  agentDraft,
  agentNodeId,
  compilePlayground,
  createBlankDraft,
  createExampleDraft,
  createSpanExampleDraft,
  duplicateAgent,
  libraryDraft,
  modelBindingNodeId,
  newToolSpec,
  type PlaygroundTreeNode,
  type PlaygroundWorkspace,
  removeAgent,
  removeLibraryTool,
  setToolAllowed,
  toolSpecNodeId,
  withAgentDraft,
  withLibraryDraft,
  workspaceFromDraft,
  workspaceNodeRef,
  workspaceTree,
} from '../../playground/mod.ts';

function must<T>(value: T | undefined): T {
  assert(value !== undefined);
  return value;
}

function keys(workspace: PlaygroundWorkspace): string[] {
  return workspace.agents.map((agent) => agent.key);
}

function allow(workspace: PlaygroundWorkspace, index: number): string[] {
  return must(workspace.agents[index]).tools.allow;
}

Deno.test('a v1 draft opens as one agent that allows every tool', () => {
  const draft = createExampleDraft();
  const workspace = workspaceFromDraft(draft, 'guardrails');
  const [key] = keys(workspace);
  assertEquals(workspace.v, 2);
  assertEquals(workspace.agents.length, 1);
  assertEquals(workspace.toolSpecs, draft.toolSpecs);
  assertEquals(
    allow(workspace, 0),
    draft.toolSpecs.map((tool) => tool.key),
  );
  assertEquals(workspace.selected, agentNodeId(must(key), 'guardrails'));
  assertEquals(workspace.chatWith, key);
  assertEquals(agentDraft(workspace, must(key)), draft);
});

Deno.test('migration keeps a selected tool unprefixed and moves the root under the agent', () => {
  const draft = createExampleDraft();
  const tool = toolSpecNodeId(must(draft.toolSpecs[0]).key);
  assertEquals(workspaceFromDraft(draft, tool).selected, tool);
  const root = workspaceFromDraft(draft, 'identity');
  assertEquals(root.selected, `agent:${keys(root)[0]}`);
});

Deno.test('every tree node id names what it is under', () => {
  const workspace = addAgent(workspaceFromDraft(createExampleDraft()), createSpanExampleDraft());
  const tree = workspaceTree(workspace);
  const ids: string[] = [];
  const walk = (node: PlaygroundTreeNode): void => {
    ids.push(node.id);
    for (const child of node.children) walk(child);
  };
  for (const node of [...tree.agents, ...tree.tools]) walk(node);
  assert(ids.length > 4);
  for (const id of ids) assert(workspaceNodeRef(workspace, id), id);
  const concierge = must(workspace.agents[0]);
  const binding = must(concierge.modelBindings[0]).key;
  assertEquals(
    workspaceNodeRef(workspace, agentNodeId(concierge.key, modelBindingNodeId(binding))),
    {
      agent: concierge.key,
      ref: { facet: 'modelBinding', key: binding },
    },
  );
  // Tools are listed once, in the library, not under each agent.
  assertEquals(ids.filter((id) => id.startsWith('toolSpec:')).length, workspace.toolSpecs.length);
  assertEquals(
    workspaceNodeRef(workspace, agentNodeId(concierge.key, toolSpecNodeId('x'))),
    undefined,
  );
  assertEquals(workspaceNodeRef(workspace, 'agent:missing'), undefined);
  assertEquals(workspaceNodeRef(workspace, 'guardrails'), undefined);
});

Deno.test('an agent sees only the tools it allows, and compiles as a single draft', () => {
  const workspace = workspaceFromDraft(createExampleDraft());
  const key = must(keys(workspace)[0]);
  const [first, ...rest] = workspace.toolSpecs;
  const tool = must(first).key;
  const narrowed = setToolAllowed(workspace, key, tool, false);
  const view = must(agentDraft(narrowed, key));
  assertEquals(view.toolSpecs, rest);
  assertEquals(narrowed.toolSpecs, workspace.toolSpecs);
  const result = compilePlayground(view);
  assert(result.ok, JSON.stringify(!result.ok && result.issues));
  assertEquals(allow(setToolAllowed(narrowed, key, tool, true), 0).at(-1), tool);
});

Deno.test('writing an agent back edits the library for everyone and only its own allow list', () => {
  const single = workspaceFromDraft(createExampleDraft());
  const workspace = duplicateAgent(single, must(keys(single)[0]));
  const [a, b] = keys(workspace).map(must);
  const draft = must(agentDraft(workspace, must(a)));
  const first = must(draft.toolSpecs[0]);
  const second = must(draft.toolSpecs[1]);
  const added = newToolSpec(draft);
  const next = withAgentDraft(workspace, must(a), {
    ...draft,
    identity: { ...draft.identity, handle: 'renamed' },
    toolSpecs: [{ ...first, description: 'changed' }, ...draft.toolSpecs.slice(2), added],
  });
  assertEquals(must(next.agents[0]).identity.handle, 'renamed');
  // An edit that leaves the tools alone keeps the library as it was.
  const renamed = withAgentDraft(workspace, must(a), {
    ...draft,
    identity: { ...draft.identity, handle: 'x' },
  });
  assert(renamed.toolSpecs === workspace.toolSpecs);
  assertEquals(must(next.toolSpecs.find((tool) => tool.key === first.key)).description, 'changed');
  assertEquals(must(must(agentDraft(next, must(b))).toolSpecs[0]).description, 'changed');
  // Dropped from a's draft: gone from a, kept in the library and on b.
  assert(next.toolSpecs.some((tool) => tool.key === second.key));
  assert(!allow(next, 0).includes(second.key));
  assert(allow(next, 1).includes(second.key));
  // New: joins the library and a, not b.
  assertEquals(next.toolSpecs.at(-1)?.key, added.key);
  assert(allow(next, 0).includes(added.key));
  assert(!allow(next, 1).includes(added.key));
});

Deno.test('duplicate gives a fresh key and agent id, right after the source', () => {
  let workspace = workspaceFromDraft(createExampleDraft());
  const source = must(keys(workspace)[0]);
  workspace = duplicateAgent(workspace, source);
  workspace = duplicateAgent(workspace, source);
  assertEquals(
    workspace.agents.map((agent) => agent.identity.agentId),
    ['travel.concierge', 'travel.concierge_copy2', 'travel.concierge_copy'],
  );
  assertEquals(new Set(keys(workspace)).size, 3);
  assertEquals(workspace.selected, agentNodeId(must(keys(workspace)[1])));
});

Deno.test('remove moves the selection and chat to a neighbour and keeps the last agent', () => {
  let workspace = addAgent(workspaceFromDraft(createBlankDraft()), createSpanExampleDraft());
  const [first, second] = keys(workspace).map(must);
  workspace = {
    ...workspace,
    selected: agentNodeId(must(second), 'models'),
    chatWith: must(second),
  };
  workspace = removeAgent(workspace, must(second));
  assertEquals(keys(workspace), [first]);
  assertEquals(workspace.selected, agentNodeId(must(first)));
  assertEquals(workspace.chatWith, first);
  assertEquals(removeAgent(workspace, must(first)), workspace);
});

Deno.test('removing a library tool takes it off every agent', () => {
  const single = workspaceFromDraft(createExampleDraft());
  let workspace = duplicateAgent(single, must(keys(single)[0]));
  const tool = must(workspace.toolSpecs[0]).key;
  workspace = removeLibraryTool({ ...workspace, selected: toolSpecNodeId(tool) }, tool);
  assert(!workspace.toolSpecs.some((spec) => spec.key === tool));
  for (const agent of workspace.agents) assert(!agent.tools.allow.includes(tool));
  assertEquals(workspace.selected, agentNodeId(must(keys(workspace)[0])));
});

Deno.test('the editor sees the whole library; a tool it adds is allowed only here, one it drops goes everywhere', () => {
  const example = workspaceFromDraft(createExampleDraft());
  const workspace = addAgent(example, createSpanExampleDraft());
  const [first, second] = workspace.agents.map((agent) => agent.key);
  const shown = must(libraryDraft(workspace, must(second)));
  assertEquals(shown.toolSpecs, workspace.toolSpecs);
  assertEquals(allow(workspace, 1), []);

  const added = newToolSpec(shown);
  const [dropped, ...rest] = shown.toolSpecs;
  const next = withLibraryDraft(workspace, must(second), {
    ...shown,
    toolSpecs: [...rest, added],
  });
  assertEquals(
    next.toolSpecs.map((tool) => tool.key),
    [...rest, added].map((tool) => tool.key),
  );
  assertEquals(allow(next, 1), [added.key]);
  assert(!allow(next, 0).includes(must(dropped).key));
  assertEquals(allow(next, 0).length, rest.length);
  assertEquals(
    must(agentDraft(next, must(first))).identity,
    must(agentDraft(workspace, must(first))).identity,
  );
});

Deno.test('an added agent gets a free id and shares the tools the library has by name', () => {
  const example = workspaceFromDraft(createExampleDraft());
  const workspace = addAgent(example, createExampleDraft());
  const first = must(workspace.agents[0]);
  const second = must(workspace.agents[1]);
  assertEquals(second.identity.agentId, `${first.identity.agentId}_2`);
  assertEquals(workspace.toolSpecs, example.toolSpecs);
  assertEquals(second.tools.allow, first.tools.allow);
  assert(compilePlayground(must(agentDraft(workspace, second.key))).ok);
});
