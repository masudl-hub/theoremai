/**
 * A workspace holds several agents and one library of tools they share. Each
 * agent is a draft without the library: it names the tools it allows by key.
 * Every draft helper still works on one agent through `agentDraft`, which puts
 * its allowed tools back, and `withAgentDraft`, which takes them out again.
 */

import {
  createBlankDraft,
  draftKey,
  freeName,
  type PlaygroundDraft,
  type ToolSpecDraft,
  type ToolsDraft,
} from './draft.ts';
import {
  type PlaygroundNodeRef,
  playgroundNodeRef,
  playgroundTree,
  type PlaygroundTreeNode,
  toolSpecKeyOf,
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

/** The inverse of `agentNodeId`; `undefined` for an id that isn't an agent's. */
function parseAgentNodeId(id: string): { key: string; inner: string } | undefined {
  if (!id.startsWith(AGENT_PREFIX)) return undefined;
  const rest = id.slice(AGENT_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return { key: rest, inner: 'identity' };
  return { key: rest.slice(0, slash), inner: rest.slice(slash + 1) };
}

/** A single draft's node id, under `agentKey`. Tools carry no agent: every agent shares them. */
export function scopedNodeId(agentKey: string, id: string): string {
  return toolSpecKeyOf(id) === undefined ? agentNodeId(agentKey, id) : id;
}

export type WorkspaceNodeRef =
  | { agent: string; ref: PlaygroundNodeRef }
  | { tool: string };

/** What a workspace node id names; `undefined` when it names nothing there. */
export function workspaceNodeRef(
  workspace: PlaygroundWorkspace,
  id: string,
): WorkspaceNodeRef | undefined {
  const tool = toolSpecKeyOf(id);
  if (tool !== undefined) {
    return workspace.toolSpecs.some((spec) => spec.key === tool) ? { tool } : undefined;
  }
  const parsed = parseAgentNodeId(id);
  const agent = parsed && workspace.agents.find((candidate) => candidate.key === parsed.key);
  if (!parsed || !agent || toolSpecKeyOf(parsed.inner) !== undefined) return undefined;
  const ref = playgroundNodeRef(draftOf(agent, []), parsed.inner);
  return ref ? { agent: agent.key, ref } : undefined;
}

/** `agent` as a single draft whose tools are the ones it allows from `library`, in library order. */
function draftOf(agent: AgentDraft, library: ToolSpecDraft[]): PlaygroundDraft {
  const { key: _key, tools: { allow, ...tools }, ...rest } = agent;
  const allowed = new Set(allow);
  return { ...rest, tools, toolSpecs: library.filter((tool) => allowed.has(tool.key)) };
}

/** One agent as a single draft: its tools are the library's it allows, in library order. */
export function agentDraft(workspace: PlaygroundWorkspace, key: string): PlaygroundDraft | undefined {
  const agent = workspace.agents.find((candidate) => candidate.key === key);
  return agent && draftOf(agent, workspace.toolSpecs);
}

/** A single draft as an agent allowing every tool it holds. */
function agentFromDraft(draft: PlaygroundDraft, key: string = draftKey('agent')): AgentDraft {
  const { toolSpecs, tools, ...rest } = draft;
  return { ...rest, key, tools: { ...tools, allow: toolSpecs.map((tool) => tool.key) } };
}

/** `toolSpecs` written into `library`: same keys replace, new keys append. Unchanged keeps the array. */
function mergeLibrary(library: ToolSpecDraft[], toolSpecs: ToolSpecDraft[]): ToolSpecDraft[] {
  const byKey = new Map(toolSpecs.map((tool) => [tool.key, tool]));
  const known = new Set(library.map((tool) => tool.key));
  const added = toolSpecs.filter((tool) => !known.has(tool.key));
  const changed = library.some((tool) => (byKey.get(tool.key) ?? tool) !== tool);
  if (!changed && added.length === 0) return library;
  return [...library.map((tool) => byKey.get(tool.key) ?? tool), ...added];
}

function mapAgent(
  workspace: PlaygroundWorkspace,
  key: string,
  change: (agent: AgentDraft) => AgentDraft,
): AgentDraft[] {
  return workspace.agents.map((agent) => (agent.key === key ? change(agent) : agent));
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
  if (!workspace.agents.some((agent) => agent.key === key)) return workspace;
  return {
    ...workspace,
    toolSpecs: mergeLibrary(workspace.toolSpecs, draft.toolSpecs),
    agents: mapAgent(workspace, key, () => agentFromDraft(draft, key)),
  };
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

/**
 * One agent as the editor shows it: its own settings, with the whole library
 * as its tools. Which of them it allows stays on the agent (`setToolAllowed`).
 */
export function libraryDraft(workspace: PlaygroundWorkspace, key: string): PlaygroundDraft | undefined {
  const agent = workspace.agents.find((candidate) => candidate.key === key);
  return agent && { ...draftOf(agent, []), toolSpecs: workspace.toolSpecs };
}

/**
 * Writes back a `libraryDraft`. Its tools become the library: a tool it
 * dropped leaves every agent, and a tool it added is allowed on this agent.
 */
export function withLibraryDraft(
  workspace: PlaygroundWorkspace,
  key: string,
  draft: PlaygroundDraft,
): PlaygroundWorkspace {
  const agent = workspace.agents.find((candidate) => candidate.key === key);
  if (!agent) return workspace;
  const kept = new Set(draft.toolSpecs.map((tool) => tool.key));
  const known = new Set(workspace.toolSpecs.map((tool) => tool.key));
  const added = draft.toolSpecs.filter((tool) => !known.has(tool.key)).map((tool) => tool.key);
  const keep = (allow: string[]) => allow.filter((toolKey) => kept.has(toolKey));
  const { toolSpecs: _library, tools, ...rest } = draft;
  return {
    ...workspace,
    toolSpecs: draft.toolSpecs,
    agents: workspace.agents.map((each) =>
      each.key === key
        ? { ...rest, key, tools: { ...tools, allow: [...keep(each.tools.allow), ...added] } }
        : each.tools.allow.every((toolKey) => kept.has(toolKey))
        ? each
        : { ...each, tools: { ...each.tools, allow: keep(each.tools.allow) } }
    ),
  };
}

/** Appends `draft` as a new agent; its tools join the library unless the library has them by key. */
export function addAgent(
  workspace: PlaygroundWorkspace,
  draft: PlaygroundDraft = createBlankDraft(),
): PlaygroundWorkspace {
  const agent = agentFromDraft(draft);
  return {
    ...workspace,
    agents: [...workspace.agents, agent],
    toolSpecs: mergeLibrary(workspace.toolSpecs, draft.toolSpecs),
    selected: agentNodeId(agent.key),
  };
}

/** A copy of an agent right after it, allowing the same tools, with an id it doesn't share. */
export function duplicateAgent(workspace: PlaygroundWorkspace, key: string): PlaygroundWorkspace {
  const index = workspace.agents.findIndex((agent) => agent.key === key);
  const source = workspace.agents[index];
  if (!source) return workspace;
  const base = source.identity.agentId.trim() || 'agent';
  const taken = workspace.agents.map((agent) => agent.identity.agentId);
  const copy: AgentDraft = { ...structuredClone(source), key: draftKey('agent') };
  copy.identity.agentId = freeName(`${base}_copy`, taken, (n) => `${base}_copy${n}`);
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
  const neighbour = agents[Math.min(index, agents.length - 1)];
  if (!neighbour) return workspace;
  const selectedGone = parseAgentNodeId(workspace.selected)?.key === key;
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
  const agent = workspace.agents.find((candidate) => candidate.key === agentKey);
  if (!agent || !workspace.toolSpecs.some((tool) => tool.key === toolKey)) return workspace;
  if (agent.tools.allow.includes(toolKey) === allowed) return workspace;
  const allow = allowed ? [...agent.tools.allow, toolKey] : agent.tools.allow.filter((key) => key !== toolKey);
  return {
    ...workspace,
    agents: mapAgent(workspace, agentKey, () => ({ ...agent, tools: { ...agent.tools, allow } })),
  };
}

/** Removes a tool from the library and from every agent that allowed it. */
export function removeLibraryTool(workspace: PlaygroundWorkspace, toolKey: string): PlaygroundWorkspace {
  if (!workspace.toolSpecs.some((tool) => tool.key === toolKey)) return workspace;
  const agents = workspace.agents.map((agent) =>
    agent.tools.allow.includes(toolKey)
      ? { ...agent, tools: { ...agent.tools, allow: agent.tools.allow.filter((key) => key !== toolKey) } }
      : agent
  );
  return {
    ...workspace,
    agents,
    toolSpecs: workspace.toolSpecs.filter((tool) => tool.key !== toolKey),
    selected: workspace.selected === toolSpecNodeId(toolKey)
      ? agentNodeId(workspace.agents[0]?.key ?? '')
      : workspace.selected,
  };
}

function scopeTree(agentKey: string, node: PlaygroundTreeNode): PlaygroundTreeNode {
  return {
    ...node,
    id: agentNodeId(agentKey, node.id),
    children: node.children.map((child) => scopeTree(agentKey, child)),
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
    agents: workspace.agents.map((agent) => scopeTree(agent.key, playgroundTree(draftOf(agent, [])))),
    tools: toolSpecNodes(workspace.toolSpecs),
  };
}
