/**
 * A workspace holds several agents and one library of tools they share. Each
 * agent is a draft without the library: it names the tools it allows by key.
 * Every draft helper still works on one agent through `agentDraft`, which puts
 * its allowed tools back, and `withAgentDraft`, which takes them out again.
 */

import { createBlankDraft, draftKey, type PlaygroundDraft, type ToolSpecDraft, type ToolsDraft } from './draft.ts';
import {
  type PlaygroundNodeRef,
  playgroundNodeRef,
  playgroundTree,
  type PlaygroundTreeNode,
  toolSpecNodeId,
  toolSpecNodes,
} from './tree.ts';

export const PLAYGROUND_WORKSPACE_VERSION = 2;

export interface AgentToolsDraft extends ToolsDraft {
  /** The library tools this agent allows, by `ToolSpecDraft.key`. */
  allow: string[];
}

/** One agent: a draft without the tool library, plus its own key and allow list. */
export interface AgentDraft extends Omit<PlaygroundDraft, 'toolSpecs' | 'tools'> {
  key: string;
  tools: AgentToolsDraft;
}

export interface PlaygroundWorkspace {
  v: typeof PLAYGROUND_WORKSPACE_VERSION;
  /** In the tree's order. */
  agents: AgentDraft[];
  /** The tools every agent picks from. */
  toolSpecs: ToolSpecDraft[];
  /** The open node's id. */
  selected: string;
  /** The agent the preview chats with, by key. */
  chatWith: string;
}

const AGENT_PREFIX = 'agent:';

/** An agent's node id: its root, or a facet or binding under it (`identity` is the root). */
export function agentNodeId(agentKey: string, inner = 'identity'): string {
  return inner === 'identity' ? `${AGENT_PREFIX}${agentKey}` : `${AGENT_PREFIX}${agentKey}/${inner}`;
}

/** A library tool's id has no agent in it: every agent shares the tool. */
function isToolId(id: string): boolean {
  return id.startsWith('toolSpec:');
}

/** A single draft's node id, under `agentKey`; a tool's id is kept as is. */
function scopedNodeId(agentKey: string, id: string): string {
  return isToolId(id) ? id : agentNodeId(agentKey, id);
}

export type WorkspaceNodeRef =
  | { agent: string; ref: PlaygroundNodeRef }
  | { tool: string };

/** What a workspace node id names; `undefined` when it names nothing there. */
export function workspaceNodeRef(
  workspace: PlaygroundWorkspace,
  id: string,
): WorkspaceNodeRef | undefined {
  if (isToolId(id)) {
    const key = id.slice('toolSpec:'.length);
    return workspace.toolSpecs.some((tool) => tool.key === key) ? { tool: key } : undefined;
  }
  if (!id.startsWith(AGENT_PREFIX)) return undefined;
  const rest = id.slice(AGENT_PREFIX.length);
  const slash = rest.indexOf('/');
  const key = slash < 0 ? rest : rest.slice(0, slash);
  const inner = slash < 0 ? 'identity' : rest.slice(slash + 1);
  const draft = agentDraft(workspace, key);
  if (!draft || isToolId(inner)) return undefined;
  const ref = playgroundNodeRef(draft, inner);
  return ref ? { agent: key, ref } : undefined;
}

export function findAgent(workspace: PlaygroundWorkspace, key: string): AgentDraft | undefined {
  return workspace.agents.find((agent) => agent.key === key);
}

/** One agent as a single draft: its tools are the library's it allows, in library order. */
export function agentDraft(workspace: PlaygroundWorkspace, key: string): PlaygroundDraft | undefined {
  const agent = findAgent(workspace, key);
  if (!agent) return undefined;
  const { key: _key, tools: { allow, ...tools }, ...rest } = agent;
  const allowed = new Set(allow);
  return { ...rest, tools, toolSpecs: workspace.toolSpecs.filter((tool) => allowed.has(tool.key)) };
}

/**
 * Writes one agent's draft back. Its tools go to the library: a changed tool
 * changes there for every agent, a new one joins the library and this agent's
 * allow list, and one the draft dropped leaves only this agent's allow list.
 */
export function withAgentDraft(
  workspace: PlaygroundWorkspace,
  key: string,
  draft: PlaygroundDraft,
): PlaygroundWorkspace {
  const agent = findAgent(workspace, key);
  if (!agent) return workspace;
  const { toolSpecs, tools, ...rest } = draft;
  const byKey = new Map(toolSpecs.map((tool) => [tool.key, tool]));
  const known = new Set(workspace.toolSpecs.map((tool) => tool.key));
  const library = [
    ...workspace.toolSpecs.map((tool) => byKey.get(tool.key) ?? tool),
    ...toolSpecs.filter((tool) => !known.has(tool.key)),
  ];
  const next: AgentDraft = { ...rest, key, tools: { ...tools, allow: toolSpecs.map((tool) => tool.key) } };
  return {
    ...workspace,
    toolSpecs: library,
    agents: workspace.agents.map((candidate) => (candidate.key === key ? next : candidate)),
  };
}

/** A single draft as an agent of `workspace`, allowing every tool it holds. */
function agentFromDraft(draft: PlaygroundDraft, key: string = draftKey('agent')): AgentDraft {
  const { toolSpecs, tools, ...rest } = draft;
  return { ...rest, key, tools: { ...tools, allow: toolSpecs.map((tool) => tool.key) } };
}

/**
 * A v1 single draft as a workspace: it becomes the one agent, its tools become
 * the library and it allows them all, and the open node moves under it.
 */
export function workspaceFromDraft(draft: PlaygroundDraft, selectedId = 'identity'): PlaygroundWorkspace {
  const agent = agentFromDraft(draft);
  return {
    v: PLAYGROUND_WORKSPACE_VERSION,
    agents: [agent],
    toolSpecs: draft.toolSpecs,
    selected: scopedNodeId(agent.key, selectedId),
    chatWith: agent.key,
  };
}

/** A workspace with one blank agent. */
export function createBlankWorkspace(): PlaygroundWorkspace {
  return workspaceFromDraft(createBlankDraft());
}

/** Appends `draft` as a new agent; its tools join the library unless the library has them by key. */
export function addAgent(
  workspace: PlaygroundWorkspace,
  draft: PlaygroundDraft = createBlankDraft(),
): PlaygroundWorkspace {
  const agent = agentFromDraft({ ...draft, toolSpecs: [] });
  const added: PlaygroundWorkspace = {
    ...workspace,
    agents: [...workspace.agents, agent],
    selected: agentNodeId(agent.key),
  };
  return withAgentDraft(added, agent.key, draft);
}

/** A copy of an agent right after it, allowing the same tools, with an id it doesn't share. */
export function duplicateAgent(workspace: PlaygroundWorkspace, key: string): PlaygroundWorkspace {
  const index = workspace.agents.findIndex((agent) => agent.key === key);
  const source = workspace.agents[index];
  if (!source) return workspace;
  const taken = new Set(workspace.agents.map((agent) => agent.identity.agentId));
  const base = source.identity.agentId.trim() || 'agent';
  let agentId = `${base}_copy`;
  for (let n = 2; taken.has(agentId); n++) agentId = `${base}_copy${n}`;
  const copy: AgentDraft = {
    ...structuredClone(source),
    key: draftKey('agent'),
    identity: { ...structuredClone(source.identity), agentId },
  };
  const agents = [...workspace.agents];
  agents.splice(index + 1, 0, copy);
  return { ...workspace, agents, selected: agentNodeId(copy.key) };
}

/**
 * Removes an agent; the last one stays. Agents that name it keep the name, so
 * compile can show the broken reference where it is. The open node and the
 * chat move to a neighbour when they were on it.
 */
export function removeAgent(workspace: PlaygroundWorkspace, key: string): PlaygroundWorkspace {
  const index = workspace.agents.findIndex((agent) => agent.key === key);
  if (index < 0 || workspace.agents.length === 1) return workspace;
  const agents = workspace.agents.filter((agent) => agent.key !== key);
  const neighbour = (agents[index] ?? agents[index - 1] ?? agents[0]) as AgentDraft;
  const ref = workspaceNodeRef(workspace, workspace.selected);
  const selectedGone = ref !== undefined && 'agent' in ref && ref.agent === key;
  return {
    ...workspace,
    agents,
    selected: selectedGone ? agentNodeId(neighbour.key) : workspace.selected,
    chatWith: workspace.chatWith === key ? neighbour.key : workspace.chatWith,
  };
}

/** Allows or stops allowing a library tool on one agent. */
export function setToolAllowed(
  workspace: PlaygroundWorkspace,
  agentKey: string,
  toolKey: string,
  allowed: boolean,
): PlaygroundWorkspace {
  const agent = findAgent(workspace, agentKey);
  if (!agent || !workspace.toolSpecs.some((tool) => tool.key === toolKey)) return workspace;
  const has = agent.tools.allow.includes(toolKey);
  if (has === allowed) return workspace;
  const allow = allowed ? [...agent.tools.allow, toolKey] : agent.tools.allow.filter((key) => key !== toolKey);
  return {
    ...workspace,
    agents: workspace.agents.map((candidate) =>
      candidate.key === agentKey ? { ...candidate, tools: { ...candidate.tools, allow } } : candidate
    ),
  };
}

/** Removes a tool from the library and from every agent that allowed it. */
export function removeLibraryTool(workspace: PlaygroundWorkspace, toolKey: string): PlaygroundWorkspace {
  if (!workspace.toolSpecs.some((tool) => tool.key === toolKey)) return workspace;
  return {
    ...workspace,
    toolSpecs: workspace.toolSpecs.filter((tool) => tool.key !== toolKey),
    agents: workspace.agents.map((agent) => ({
      ...agent,
      tools: { ...agent.tools, allow: agent.tools.allow.filter((key) => key !== toolKey) },
    })),
    selected: workspace.selected === toolSpecNodeId(toolKey)
      ? agentNodeId(workspace.agents[0]?.key ?? '')
      : workspace.selected,
  };
}

function scopeTree(agentKey: string, node: PlaygroundTreeNode): PlaygroundTreeNode {
  return {
    ...node,
    id: scopedNodeId(agentKey, node.id),
    children: node.children.filter((child) => !isToolId(child.id)).map((child) => scopeTree(agentKey, child)),
  };
}

export interface WorkspaceTree {
  /** One root per agent; its tools are picked in its Tools facet, not listed under it. */
  agents: PlaygroundTreeNode[];
  /** The shared library. */
  tools: PlaygroundTreeNode[];
}

export function workspaceTree(workspace: PlaygroundWorkspace): WorkspaceTree {
  return {
    agents: workspace.agents.map((agent) =>
      scopeTree(agent.key, playgroundTree(agentDraft(workspace, agent.key) as PlaygroundDraft))
    ),
    tools: toolSpecNodes(workspace.toolSpecs),
  };
}
