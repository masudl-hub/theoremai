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
  type StudioDraft,
  type ToolSpecDraft,
  type ToolsDraft,
} from './draft.ts';
import {
  type StudioNodeRef,
  studioNodeRef,
  studioTree,
  type StudioTreeNode,
  toolSpecKeyOf,
  toolSpecNodeId,
  toolSpecNodes,
} from './tree.ts';

export const STUDIO_WORKSPACE_VERSION = 3;

export interface AgentToolsDraft extends ToolsDraft {
  /** The library tools this agent allows, by `ToolSpecDraft.key`. */
  allow: string[];
}

/** One agent: a draft without the tool library, plus its own key and allow list. */
export interface AgentDraft extends Omit<StudioDraft, 'toolSpecs' | 'tools'> {
  key: string;
  tools: AgentToolsDraft;
}

/**
 * What each agent and tool held when it joined the workspace, by key: an example as it loaded, or a
 * new one as it was made. Reset puts one back. A tool that left the library keeps its start while
 * an agent that started with it is still here, so resetting that agent brings the tool back.
 */
export interface WorkspaceStarts {
  agents: Record<string, AgentDraft>;
  tools: Record<string, ToolSpecDraft>;
}

export interface StudioWorkspace {
  v: typeof STUDIO_WORKSPACE_VERSION;
  /** In the tree's order. */
  agents: AgentDraft[];
  /** The tools every agent picks from. */
  toolSpecs: ToolSpecDraft[];
  /** The open node's id. */
  selected: string;
  /** The agent the preview chats with, by key. */
  chatWith: string;
  starts: WorkspaceStarts;
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
  | { agent: string; ref: StudioNodeRef }
  | { tool: string };

/** What a workspace node id names; `undefined` when it names nothing there. */
export function workspaceNodeRef(
  workspace: StudioWorkspace,
  id: string,
): WorkspaceNodeRef | undefined {
  const tool = toolSpecKeyOf(id);
  if (tool !== undefined) {
    return workspace.toolSpecs.some((spec) => spec.key === tool) ? { tool } : undefined;
  }
  const parsed = parseAgentNodeId(id);
  const agent = parsed && workspace.agents.find((candidate) => candidate.key === parsed.key);
  if (!parsed || !agent || toolSpecKeyOf(parsed.inner) !== undefined) return undefined;
  const ref = studioNodeRef(draftOf(agent, []), parsed.inner);
  return ref ? { agent: agent.key, ref } : undefined;
}

/** `agent` as a single draft whose tools are the ones it allows from `library`, in library order. */
function draftOf(agent: AgentDraft, library: ToolSpecDraft[]): StudioDraft {
  const { key: _key, tools: { allow, ...tools }, ...rest } = agent;
  const allowed = new Set(allow);
  return { ...rest, tools, toolSpecs: library.filter((tool) => allowed.has(tool.key)) };
}

/** One agent as a single draft: its tools are the library's it allows, in library order. */
export function agentDraft(workspace: StudioWorkspace, key: string): StudioDraft | undefined {
  const agent = workspace.agents.find((candidate) => candidate.key === key);
  return agent && draftOf(agent, workspace.toolSpecs);
}

/** A single draft as an agent allowing every tool it holds. */
function agentFromDraft(draft: StudioDraft, key: string = draftKey('agent')): AgentDraft {
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
  workspace: StudioWorkspace,
  key: string,
  change: (agent: AgentDraft) => AgentDraft,
): AgentDraft[] {
  return workspace.agents.map((agent) => (agent.key === key ? change(agent) : agent));
}

/**
 * Gives a start to each agent and tool that has none, and forgets the starts nothing can reach:
 * a removed agent's, and a tool's that is in no library and no agent's start.
 */
function remembered(workspace: StudioWorkspace): StudioWorkspace {
  const agents = Object.fromEntries(
    workspace.agents.map((agent) => [agent.key, workspace.starts.agents[agent.key] ?? agent]),
  );
  const held = new Map(workspace.toolSpecs.map((tool) => [tool.key, tool]));
  const reachable = new Set([...held.keys(), ...Object.values(agents).flatMap((agent) => agent.tools.allow)]);
  const tools: Record<string, ToolSpecDraft> = {};
  for (const key of reachable) {
    const start = workspace.starts.tools[key] ?? held.get(key);
    if (start) tools[key] = start;
  }
  return { ...workspace, starts: { agents, tools } };
}

/** Makes what an agent holds now its start: for an example that links its agents after adding them. */
export function markAgentStart(workspace: StudioWorkspace, key: string): StudioWorkspace {
  const agent = workspace.agents.find((candidate) => candidate.key === key);
  if (!agent) return workspace;
  return remembered({
    ...workspace,
    starts: { ...workspace.starts, agents: { ...workspace.starts.agents, [key]: agent } },
  });
}

/**
 * Writes one agent's draft back. Its tools go to the library: a changed tool
 * changes there for every agent, a new one joins the library and this agent's
 * allow list, and one the draft dropped leaves only this agent's allow list.
 * `registered` updates the library for a tool the file defines and does not allow.
 */
export function withAgentDraft(
  workspace: StudioWorkspace,
  key: string,
  draft: StudioDraft,
  registered?: readonly ToolSpecDraft[],
): StudioWorkspace {
  if (!workspace.agents.some((agent) => agent.key === key)) return workspace;
  const defined = registered ? mergeLibrary(workspace.toolSpecs, [...registered]) : workspace.toolSpecs;
  return remembered({
    ...workspace,
    toolSpecs: mergeLibrary(defined, draft.toolSpecs),
    agents: mapAgent(workspace, key, () => agentFromDraft(draft, key)),
  });
}

/**
 * A v1 single draft as a workspace: it becomes the one agent, its tools become
 * the library and it allows them all, and the open node moves under it.
 */
export function workspaceFromDraft(draft: StudioDraft, selectedId = 'identity'): StudioWorkspace {
  const agent = agentFromDraft(draft);
  return remembered({
    v: STUDIO_WORKSPACE_VERSION,
    agents: [agent],
    toolSpecs: draft.toolSpecs,
    selected: scopedNodeId(agent.key, selectedId),
    chatWith: agent.key,
    starts: { agents: {}, tools: {} },
  });
}

/** A workspace with one blank agent. */
export function createBlankWorkspace(): StudioWorkspace {
  return workspaceFromDraft(createBlankDraft());
}

/**
 * One agent as the editor shows it: its own settings, with the whole library
 * as its tools. Which of them it allows stays on the agent (`setToolAllowed`).
 */
export function libraryDraft(workspace: StudioWorkspace, key: string): StudioDraft | undefined {
  const agent = workspace.agents.find((candidate) => candidate.key === key);
  return agent && { ...draftOf(agent, []), toolSpecs: workspace.toolSpecs };
}

/**
 * Writes back a `libraryDraft`. Its tools become the library: a tool it
 * dropped leaves every agent, and a tool it added is allowed on this agent.
 */
export function withLibraryDraft(
  workspace: StudioWorkspace,
  key: string,
  draft: StudioDraft,
): StudioWorkspace {
  const agent = workspace.agents.find((candidate) => candidate.key === key);
  if (!agent) return workspace;
  const kept = new Set(draft.toolSpecs.map((tool) => tool.key));
  const known = new Set(workspace.toolSpecs.map((tool) => tool.key));
  const added = draft.toolSpecs.filter((tool) => !known.has(tool.key)).map((tool) => tool.key);
  const keep = (allow: string[]) => allow.filter((toolKey) => kept.has(toolKey));
  const { toolSpecs: _library, tools, ...rest } = draft;
  return remembered({
    ...workspace,
    toolSpecs: draft.toolSpecs,
    agents: workspace.agents.map((each) =>
      each.key === key
        ? { ...rest, key, tools: { ...tools, allow: [...keep(each.tools.allow), ...added] } }
        : each.tools.allow.every((toolKey) => kept.has(toolKey))
        ? each
        : { ...each, tools: { ...each.tools, allow: keep(each.tools.allow) } }
    ),
  });
}

/**
 * Appends `draft` as a new agent, with an id no other agent has. A tool whose
 * name the library already has is shared, not copied; the rest join the library.
 */
export function addAgent(
  workspace: StudioWorkspace,
  draft: StudioDraft = createBlankDraft(),
): StudioWorkspace {
  const shared = new Map(workspace.toolSpecs.map((tool) => [tool.toolName, tool.key]));
  const base = draft.identity.agentId.trim();
  const taken = workspace.agents.map((agent) => agent.identity.agentId);
  const agentId = base && freeName(base, taken, (n) => `${base}_${n}`);
  const agent = agentFromDraft({ ...draft, identity: { ...draft.identity, agentId } });
  agent.tools.allow = draft.toolSpecs.map((tool) => shared.get(tool.toolName) ?? tool.key);
  return remembered({
    ...workspace,
    agents: [...workspace.agents, agent],
    toolSpecs: [
      ...workspace.toolSpecs,
      ...draft.toolSpecs.filter((tool) => !shared.has(tool.toolName)),
    ],
    selected: agentNodeId(agent.key),
  });
}

/** A copy of an agent right after it, allowing the same tools, with an id it doesn't share. */
export function duplicateAgent(workspace: StudioWorkspace, key: string): StudioWorkspace {
  const index = workspace.agents.findIndex((agent) => agent.key === key);
  const source = workspace.agents[index];
  if (!source) return workspace;
  const base = source.identity.agentId.trim() || 'agent';
  const taken = workspace.agents.map((agent) => agent.identity.agentId);
  const copy: AgentDraft = { ...structuredClone(source), key: draftKey('agent') };
  copy.identity.agentId = freeName(`${base}_copy`, taken, (n) => `${base}_copy${n}`);
  const agents = [...workspace.agents];
  agents.splice(index + 1, 0, copy);
  return remembered({ ...workspace, agents, selected: agentNodeId(copy.key) });
}

/**
 * Removes an agent; the last one stays. Nothing is left pointing at it: the
 * agent tools that ran it leave the library and every agent, and a model it
 * summarised for goes back to summarising itself. The open node and the chat
 * move to a neighbour when they were on it.
 */
export function removeAgent(workspace: StudioWorkspace, key: string): StudioWorkspace {
  const index = workspace.agents.findIndex((agent) => agent.key === key);
  if (index < 0 || workspace.agents.length === 1) return workspace;
  const neighbour = workspace.agents[index + 1] ?? workspace.agents[index - 1];
  if (!neighbour) return workspace;
  const ranIt = new Set(
    workspace.toolSpecs
      .filter((tool) => tool.toolType === 'agent' && tool.agentKey === key)
      .map((tool) => tool.key),
  );
  const agents = workspace.agents
    .filter((agent) => agent.key !== key)
    .map((agent) => ({
      ...agent,
      tools: { ...agent.tools, allow: agent.tools.allow.filter((toolKey) => !ranIt.has(toolKey)) },
      modelBindings: agent.modelBindings.map((binding) =>
        binding.compactWith === key ? { ...binding, compactWith: undefined } : binding
      ),
    }));
  const gone = parseAgentNodeId(workspace.selected)?.key === key ||
    [...ranIt].some((toolKey) => workspace.selected === toolSpecNodeId(toolKey));
  return remembered({
    ...workspace,
    agents,
    toolSpecs: workspace.toolSpecs.filter((tool) => !ranIt.has(tool.key)),
    selected: gone ? agentNodeId(neighbour.key) : workspace.selected,
    chatWith: workspace.chatWith === key ? neighbour.key : workspace.chatWith,
  });
}

/** Allows or stops allowing a library tool on one agent. */
export function setToolAllowed(
  workspace: StudioWorkspace,
  agentKey: string,
  toolKey: string,
  allowed: boolean,
): StudioWorkspace {
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
export function removeLibraryTool(workspace: StudioWorkspace, toolKey: string): StudioWorkspace {
  if (!workspace.toolSpecs.some((tool) => tool.key === toolKey)) return workspace;
  const agents = workspace.agents.map((agent) =>
    agent.tools.allow.includes(toolKey)
      ? { ...agent, tools: { ...agent.tools, allow: agent.tools.allow.filter((key) => key !== toolKey) } }
      : agent
  );
  return remembered({
    ...workspace,
    agents,
    toolSpecs: workspace.toolSpecs.filter((tool) => tool.key !== toolKey),
    selected: workspace.selected === toolSpecNodeId(toolKey)
      ? agentNodeId(workspace.agents[0]?.key ?? '')
      : workspace.selected,
  });
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Whether every agent and tool is as it started, and no tool was added or removed. */
export function atStart(workspace: StudioWorkspace): boolean {
  const { agents, tools } = workspace.starts;
  return workspace.agents.every((agent) => same(agent, agents[agent.key])) &&
    workspace.toolSpecs.every((tool) => same(tool, tools[tool.key])) &&
    Object.keys(tools).length === workspace.toolSpecs.length;
}

/** Makes what the workspace holds now its start: after a Save, the project's files hold it. */
export function startedHere(workspace: StudioWorkspace): StudioWorkspace {
  return {
    ...workspace,
    starts: {
      agents: Object.fromEntries(workspace.agents.map((agent) => [agent.key, agent])),
      tools: Object.fromEntries(workspace.toolSpecs.map((tool) => [tool.key, tool])),
    },
  };
}

/**
 * Puts one agent back to its start: its own settings and the tools it allowed. The tools keep
 * their edits, since other agents share them; one that left the library comes back as it started.
 * Nothing else changes. An agent already at its start returns the same workspace.
 */
export function resetAgent(workspace: StudioWorkspace, key: string): StudioWorkspace {
  const start = workspace.starts.agents[key];
  const now = workspace.agents.find((agent) => agent.key === key);
  if (!start || !now) return workspace;
  const here = new Set(workspace.agents.map((agent) => agent.key));
  const library = new Set(workspace.toolSpecs.map((tool) => tool.key));
  const names = workspace.toolSpecs.map((tool) => tool.toolName);
  const back: ToolSpecDraft[] = [];
  for (const toolKey of start.tools.allow) {
    const tool = workspace.starts.tools[toolKey];
    if (library.has(toolKey) || !tool) continue;
    // An agent tool whose agent was removed has nothing to run.
    if (tool.toolType === 'agent' && !here.has(tool.agentKey ?? '')) continue;
    const toolName = freeName(tool.toolName, names, (n) => `${tool.toolName}_${n}`);
    names.push(toolName);
    back.push({ ...tool, toolName });
  }
  const toolSpecs = back.length ? [...workspace.toolSpecs, ...back] : workspace.toolSpecs;
  const held = new Set(toolSpecs.map((tool) => tool.key));
  const id = start.identity.agentId;
  const others = workspace.agents.filter((agent) => agent.key !== key).map((agent) => agent.identity.agentId);
  const agent: AgentDraft = {
    ...start,
    identity: { ...start.identity, agentId: id && freeName(id, others, (n) => `${id}_${n}`) },
    tools: { ...start.tools, allow: start.tools.allow.filter((toolKey) => held.has(toolKey)) },
    modelBindings: start.modelBindings.map((binding) =>
      binding.compactWith && !here.has(binding.compactWith) ? { ...binding, compactWith: undefined } : binding
    ),
  };
  if (back.length === 0 && same(agent, now)) return workspace;
  const next = { ...workspace, agents: mapAgent(workspace, key, () => agent), toolSpecs };
  return workspaceNodeRef(next, next.selected) ? next : { ...next, selected: agentNodeId(key) };
}

/**
 * Puts every agent and every library tool back to its start, in one step. A tool that left the
 * library comes back when an agent started out allowing it. An agent or a tool added here stays: it
 * started as it is. A workspace already at its start is returned as it is.
 */
export function resetAll(workspace: StudioWorkspace): StudioWorkspace {
  const { starts } = workspace;
  const here = new Set(workspace.agents.map((agent) => agent.key));
  const library = new Map(workspace.toolSpecs.map((tool) => [tool.key, starts.tools[tool.key] ?? tool]));
  for (const agent of workspace.agents) {
    for (const toolKey of starts.agents[agent.key]?.tools.allow ?? []) {
      const tool = starts.tools[toolKey];
      if (!tool || library.has(toolKey)) continue;
      // An agent tool whose agent was removed has nothing to run.
      if (tool.toolType === 'agent' && !here.has(tool.agentKey ?? '')) continue;
      library.set(toolKey, tool);
    }
  }
  // Two that started under one name cannot both hold it: the later one takes the next free name.
  const names: string[] = [];
  const toolSpecs = [...library.values()].map((tool) => {
    const toolName = freeName(tool.toolName, names, (n) => `${tool.toolName}_${n}`);
    names.push(toolName);
    return toolName === tool.toolName ? tool : { ...tool, toolName };
  });
  const ids: string[] = [];
  const agents = workspace.agents.map((now): AgentDraft => {
    const start = starts.agents[now.key] ?? now;
    const id = start.identity.agentId;
    const agentId = id && freeName(id, ids, (n) => `${id}_${n}`);
    ids.push(agentId);
    return {
      ...start,
      identity: { ...start.identity, agentId },
      tools: { ...start.tools, allow: start.tools.allow.filter((toolKey) => library.has(toolKey)) },
      modelBindings: start.modelBindings.map((binding) =>
        binding.compactWith && !here.has(binding.compactWith) ? { ...binding, compactWith: undefined } : binding
      ),
    };
  });
  if (same(agents, workspace.agents) && same(toolSpecs, workspace.toolSpecs)) return workspace;
  const next = { ...workspace, agents, toolSpecs };
  const first = agents[0];
  return workspaceNodeRef(next, next.selected) || !first ? next : { ...next, selected: agentNodeId(first.key) };
}

/**
 * The files' workspace, opened again over the one the studio holds. An agent or a tool the studio
 * already opened from the files keeps its key, so what is open, each conversation and the
 * settings agents share carry on. One the builder removed comes back under a new key.
 */
export function reopened(files: StudioWorkspace, before: StudioWorkspace): StudioWorkspace {
  const agents = new Map(Object.values(before.starts.agents).map((agent) => [agent.identity.agentId, agent.key]));
  const tools = new Map(Object.values(before.starts.tools).map((tool) => [tool.toolName, tool.key]));
  let text = JSON.stringify(files);
  const rekey = (from: string, to: string | undefined) => {
    if (to !== undefined && to !== from) text = text.split(from).join(to);
  };
  for (const agent of files.agents) rekey(agent.key, agents.get(agent.identity.agentId));
  for (const tool of files.toolSpecs) rekey(tool.key, tools.get(tool.toolName));
  const next = JSON.parse(text) as StudioWorkspace;
  return {
    ...next,
    selected: workspaceNodeRef(next, before.selected) ? before.selected : next.selected,
    chatWith: next.agents.some((agent) => agent.key === before.chatWith) ? before.chatWith : next.chatWith,
  };
}

/**
 * The builder's edits brought back over files that changed since they were made. What the builder
 * changed or added stays as they left it, and what they did not touch is as the files hold it
 * now. Every start is the files', so an edit made on the old files is one the new files do not
 * hold. A tool the builder removed stays removed; an agent they removed comes back.
 */
export function rebased(edits: StudioWorkspace, files: StudioWorkspace): StudioWorkspace {
  const now = reopened(files, edits);
  const laid = <T extends { key: string }>(
    held: readonly T[],
    starts: Record<string, T>,
    inFiles: readonly T[],
    fileStarts: Record<string, T>,
  ) => {
    const file = new Map(inFiles.map((each) => [each.key, each]));
    // What stands in the studio, or stood there and was removed, is not the files' to add.
    const known = new Set([...held.map((each) => each.key), ...Object.keys(starts)]);
    const kept = held.map((each) => (same(each, starts[each.key]) ? file.get(each.key) ?? each : each));
    // One the files do not hold was added here, and starts where it did.
    const added = kept.filter((each) => !(each.key in fileStarts)).map((each) => [each.key, starts[each.key] ?? each]);
    return {
      held: [...kept, ...inFiles.filter((each) => !known.has(each.key))],
      starts: { ...Object.fromEntries(added), ...fileStarts } as Record<string, T>,
    };
  };
  const agents = laid(edits.agents, edits.starts.agents, now.agents, now.starts.agents);
  const tools = laid(edits.toolSpecs, edits.starts.tools, now.toolSpecs, now.starts.tools);
  return {
    ...edits,
    agents: agents.held,
    toolSpecs: tools.held,
    starts: { agents: agents.starts, tools: tools.starts },
  };
}

/**
 * A project's files as the studio opened them, as a short text that stays the same until they
 * change. An agent's or a tool's key is new on every open, so each is named by where it first
 * stands. What is open and who the preview talks to are not part of it.
 */
export function filesPrint(workspace: StudioWorkspace): string {
  const names = new Map<string, string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(collect);
    if (typeof value !== 'object' || value === null) return;
    for (const [field, inner] of Object.entries(value)) {
      if (field !== 'key' || typeof inner !== 'string') collect(inner);
      else if (!names.has(inner)) names.set(inner, `#${names.size}`);
    }
  };
  const named = (value: unknown): unknown => {
    if (typeof value === 'string') return names.get(value) ?? value;
    if (Array.isArray(value)) return value.map(named);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([field, inner]) => [names.get(field) ?? field, named(inner)]),
    );
  };
  const held = { agents: workspace.agents, toolSpecs: workspace.toolSpecs };
  collect(held);
  const text = JSON.stringify(named(held));
  // Two 32-bit FNV-1a passes: enough to tell one reading of the files from another.
  let low = 0x811c9dc5;
  let high = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    low = Math.imul(low ^ code, 0x01000193);
    high = Math.imul(high ^ code, 0x85ebca6b);
  }
  return `${text.length.toString(36)}-${(low >>> 0).toString(36)}${(high >>> 0).toString(36)}`;
}

/**
 * Whether the workspace holds edits the files it stands on do not: a change, or an agent or a
 * tool added or removed. `files` is the print of those files.
 */
export function editedSince(workspace: StudioWorkspace, files: string): boolean {
  return filesPrint(workspace) !== files;
}

/** One setting inside an agent or a tool, as the fields that lead to it. Empty for the whole agent or tool. */
export type SettingPath = readonly (string | number)[];

/** A setting the project's files changed. */
export interface FileUpdate {
  kind: 'agent' | 'tool';
  /** The agent's or the tool's key in the merged workspace. */
  key: string;
  /** The agent's id or the tool's name, as the files hold it. */
  name: string;
  path: SettingPath;
}

/** A setting the builder and the files both changed, to different values. Undefined is a removal. */
export interface FileConflict extends FileUpdate {
  mine: unknown;
  theirs: unknown;
}

export interface FilesMerge {
  /** The builder's edits over the files as they are now, with the builder's value at every conflict. */
  workspace: StudioWorkspace;
  /** What the files changed that the builder had not touched: it is as the files hold it. */
  updated: FileUpdate[];
  conflicts: FileConflict[];
  /** The files as they are now, under the keys the workspace holds them by. */
  files: StudioWorkspace;
}

const DRAFT_KEY = /^(agent|model|tool|question|criterion|reference)-[0-9a-f]{8}$/;

/** A value as text with each key named by where it first stands, so two opens of one thing read the same. */
function keyless(value: unknown): string {
  const names = new Map<string, string>();
  return JSON.stringify(value).replace(/\b(agent|model|tool|question|criterion|reference)-[0-9a-f]{8}\b/g, (key) => {
    if (!names.has(key)) names.set(key, `#${names.size}`);
    return names.get(key) ?? key;
  });
}

/**
 * Each thing in a start's list with the one in the files' list it is: the one that reads the
 * same, and otherwise the next one left. So a row the files add or take out moves no other row.
 */
function paired(start: readonly unknown[], file: readonly unknown[]): [unknown, unknown][] {
  const texts = file.map(keyless);
  const taken = new Set<number>();
  const pairs: [unknown, unknown][] = [];
  const unmatched: unknown[] = [];
  for (const each of start) {
    const text = keyless(each);
    const at = texts.findIndex((other, index) => other === text && !taken.has(index));
    if (at < 0) unmatched.push(each);
    else {
      taken.add(at);
      pairs.push([each, file[at]]);
    }
  }
  const left = file.filter((_, index) => !taken.has(index));
  unmatched.slice(0, left.length).forEach((each, index) => pairs.push([each, left[index]]));
  return pairs;
}

/**
 * The files with an agent or a tool they renamed under the key the studio holds it by. It is a
 * rename when one the studio opened is gone, one it never held is there, and the two read the
 * same but for the name.
 */
function renamedAsHeld(now: StudioWorkspace, edits: StudioWorkspace): StudioWorkspace {
  let text = JSON.stringify(now);
  const pair = <T extends { key: string }>(
    held: readonly T[],
    starts: Record<string, T>,
    inFiles: readonly T[],
    unnamed: (each: T) => T,
  ) => {
    const file = new Set(inFiles.map((each) => each.key));
    const here = new Set(held.map((each) => each.key));
    const gone = held.flatMap((each) => (file.has(each.key) ? [] : starts[each.key] ?? []));
    const fresh = inFiles.filter((each) => !here.has(each.key) && !starts[each.key]);
    const [was, is] = [gone[0], fresh[0]];
    if (gone.length !== 1 || fresh.length !== 1 || !was || !is) return;
    if (keyless(unnamed(was)) === keyless(unnamed(is))) text = text.split(is.key).join(was.key);
  };
  pair(edits.agents, edits.starts.agents, now.agents, (agent) => ({
    ...agent,
    identity: { ...agent.identity, agentId: '' },
  }));
  pair(edits.toolSpecs, edits.starts.tools, now.toolSpecs, (tool) => ({ ...tool, toolName: '' }));
  return JSON.parse(text) as StudioWorkspace;
}

/**
 * `now` with the keys inside each agent and tool named as its start names them. A key is new on
 * every open, so what stands in the same place in the start gives its key: a model, a question.
 */
function alignedToStarts(now: StudioWorkspace, starts: WorkspaceStarts): StudioWorkspace {
  let text = JSON.stringify(now);
  // A key can name a field, whose inner keys line up only once it does: so more than one pass.
  for (let pass = 0; pass < 4; pass += 1) {
    const held = JSON.parse(text) as StudioWorkspace;
    const renames = new Map<string, string>();
    const walk = (start: unknown, file: unknown): void => {
      if (Array.isArray(start) && Array.isArray(file)) {
        for (const [each, other] of paired(start, file)) walk(each, other);
      } else if (isRecord(start) && isRecord(file)) {
        for (const [field, inner] of Object.entries(start)) {
          const other = file[field];
          if (field !== 'key') walk(inner, other);
          else if (
            typeof inner === 'string' && typeof other === 'string' && inner !== other &&
            DRAFT_KEY.test(inner) && DRAFT_KEY.test(other)
          ) renames.set(other, inner);
        }
      }
    };
    for (const agent of held.agents) walk(starts.agents[agent.key], agent);
    for (const tool of held.toolSpecs) walk(starts.tools[tool.key], tool);
    if (renames.size === 0) return held;
    for (const [from, to] of renames) text = text.split(from).join(to);
  }
  return JSON.parse(text) as StudioWorkspace;
}

const isNames = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((each) => typeof each === 'string') && new Set(value).size === value.length;

type Row = Record<string, unknown> & { key: string };

/** Whether a list holds keyed rows: models, questions. */
const isRows = (value: unknown): value is Row[] =>
  Array.isArray(value) && value.every((row) => isRecord(row) && typeof row.key === 'string');

/**
 * One value three ways: what the files held, what the builder holds and what the files hold now.
 * A record merges field by field, a list of keyed rows row by row, and a list of names as a set.
 * A row either side added stays, and one either side took out goes unless the other changed it.
 * Anything else is one setting: whoever changed it has it, and both changing it is a conflict the
 * builder's value stands in for.
 */
function mergedValue(
  base: unknown,
  mine: unknown,
  theirs: unknown,
  path: SettingPath,
  tell: { updated(path: SettingPath): void; conflict(path: SettingPath, mine: unknown, theirs: unknown): void },
): unknown {
  if (same(base, theirs) || same(mine, theirs)) return mine;
  if (isRecord(base) && isRecord(mine) && isRecord(theirs)) {
    const next = { ...mine };
    for (const field of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
      const value = mergedValue(base[field], mine[field], theirs[field], [...path, field], tell);
      if (value === undefined) delete next[field];
      else next[field] = value;
    }
    return next;
  }
  if (isRows(base) && isRows(mine) && isRows(theirs)) {
    const was = new Map(base.map((row) => [row.key, row]));
    const now = new Map(theirs.map((row) => [row.key, row]));
    const kept: unknown[] = [];
    for (const row of mine) {
      const [start, file] = [was.get(row.key), now.get(row.key)];
      const at = [...path, kept.length];
      if (!start) kept.push(row);
      else if (file) kept.push(mergedValue(start, row, file, at, tell));
      else if (same(row, start)) tell.updated(at);
      else {
        tell.conflict(at, row, undefined);
        kept.push(row);
      }
    }
    const here = new Set(mine.map((row) => row.key));
    // A row the builder took out and the files changed: it would come back after the rows kept.
    let back = kept.length;
    for (const row of theirs) {
      if (here.has(row.key)) continue;
      const start = was.get(row.key);
      if (!start) {
        tell.updated([...path, kept.length]);
        kept.push(row);
        back += 1;
      } else if (!same(row, start)) tell.conflict([...path, back++], undefined, row);
    }
    return kept;
  }
  if (same(base, mine)) {
    tell.updated(path);
    return theirs;
  }
  if (isNames(base) && isNames(mine) && isNames(theirs)) {
    const taken = base.filter((name) => !theirs.includes(name));
    const added = theirs.filter((name) => !base.includes(name) && !mine.includes(name));
    tell.updated(path);
    return [...mine.filter((name) => !taken.includes(name)), ...added];
  }
  tell.conflict(path, mine, theirs);
  return mine;
}

/** Leaves nothing pointing at an agent or a tool that is not there, and keeps something open. */
function sound(workspace: StudioWorkspace): StudioWorkspace {
  const agentKeys = new Set(workspace.agents.map((agent) => agent.key));
  // An agent tool whose agent is gone has nothing to run.
  const toolSpecs = workspace.toolSpecs.filter((tool) =>
    tool.toolType !== 'agent' || agentKeys.has(tool.agentKey ?? '')
  );
  const library = new Set(toolSpecs.map((tool) => tool.key));
  const agents = workspace.agents.map((agent): AgentDraft => {
    const allow = agent.tools.allow.filter((toolKey) => library.has(toolKey));
    const modelBindings = agent.modelBindings.map((binding) =>
      binding.compactWith && !agentKeys.has(binding.compactWith) ? { ...binding, compactWith: undefined } : binding
    );
    const next = { ...agent, tools: { ...agent.tools, allow }, modelBindings };
    return same(next, agent) ? agent : next;
  });
  const next = remembered({ ...workspace, agents, toolSpecs });
  const first = agents[0];
  return {
    ...next,
    selected: workspaceNodeRef(next, next.selected) || !first ? next.selected : agentNodeId(first.key),
    chatWith: agentKeys.has(next.chatWith) || !first ? next.chatWith : first.key,
  };
}

/**
 * The builder's edits merged with files that changed under them, setting by setting. What only
 * the files changed is as the files hold it; what only the builder changed stays; what both
 * changed to different values is a conflict, and the builder's value stands until they choose
 * (`withFilesChosen`). Every start is the files', so what is left to save is the builder's edits.
 *
 * `before` is the files as the studio last read them. It tells an agent the files took away from
 * one the builder added, and names the agents the builder removed, which keep no start. Without
 * it nothing the studio holds is taken away, and an agent the builder removed comes back.
 */
export function mergedWithFiles(edits: StudioWorkspace, files: StudioWorkspace, before?: StudioWorkspace): FilesMerge {
  const now = alignedToStarts(renamedAsHeld(reopened(files, edits), edits), edits.starts);
  const updated: FileUpdate[] = [];
  const conflicts: FileConflict[] = [];
  const laid = <T extends { key: string }>(
    kind: FileUpdate['kind'],
    nameOf: (each: T) => string,
    held: readonly T[],
    starts: Record<string, T>,
    inFiles: readonly T[],
    fileStarts: Record<string, T>,
    read: readonly T[] | undefined,
  ) => {
    const file = new Map(inFiles.map((each) => [each.key, each]));
    const here = new Set(held.map((each) => each.key));
    const names = new Set(held.map((each) => nameOf(starts[each.key] ?? each)));
    const wasRead = new Set(read?.map(nameOf));
    const kept: T[] = [];
    const nextStarts: Record<string, T> = { ...fileStarts };
    for (const mine of held) {
      const [base, theirs] = [starts[mine.key], file.get(mine.key)];
      const of = { kind, key: mine.key, name: nameOf(theirs ?? base ?? mine) };
      if (!base || (!theirs && !wasRead.has(nameOf(base)))) {
        // Added here, since the files never held it: it starts as it did.
        kept.push(mine);
        nextStarts[mine.key] = base ?? mine;
      } else if (!theirs) {
        // The files took it away: it goes unless the builder changed it.
        if (same(mine, base)) updated.push({ ...of, path: [] });
        else {
          conflicts.push({ ...of, path: [], mine, theirs: undefined });
          kept.push(mine);
          nextStarts[mine.key] = base;
        }
      } else {
        kept.push(
          mergedValue(base, mine, theirs, [], {
            updated: (path) => updated.push({ ...of, path }),
            conflict: (path, yours, files) => conflicts.push({ ...of, path, mine: yours, theirs: files }),
          }) as T,
        );
      }
    }
    // Whether the builder removed what the files hold, and whether the files changed it since.
    const removedHere = (theirs: T): 'unchanged' | 'changed' | undefined => {
      // A start outlives its removal for a tool an agent started with; the last reading names the rest.
      const was = starts[theirs.key] ?? read?.find((each) => nameOf(each) === nameOf(theirs) && !names.has(nameOf(each)));
      if (!was) return undefined;
      // What it points at may have a new key: an agent tool's agent, removed with it.
      return keyless(was) === keyless(theirs) ? 'unchanged' : 'changed';
    };
    for (const theirs of inFiles) {
      if (here.has(theirs.key)) continue;
      const of = { kind, key: theirs.key, name: nameOf(theirs), path: [] };
      const removed = removedHere(theirs);
      if (removed === 'changed') conflicts.push({ ...of, mine: undefined, theirs });
      else if (removed === undefined) {
        kept.push(theirs);
        updated.push(of);
      }
    }
    return { held: kept, starts: nextStarts };
  };
  const agents = laid(
    'agent',
    (agent: AgentDraft) => agent.identity.agentId,
    edits.agents,
    edits.starts.agents,
    now.agents,
    now.starts.agents,
    before?.agents,
  );
  const tools = laid(
    'tool',
    (tool: ToolSpecDraft) => tool.toolName,
    edits.toolSpecs,
    edits.starts.tools,
    now.toolSpecs,
    now.starts.tools,
    before?.toolSpecs,
  );
  const workspace = sound({
    ...edits,
    agents: agents.held,
    toolSpecs: tools.held,
    starts: { agents: agents.starts, tools: tools.starts },
  });
  return { workspace, updated, conflicts, files: now };
}

/** Stands where a row was taken out, so the rows after it keep their places until every choice is in. */
const GONE = Object.freeze({ gone: true });

function withoutGone<T>(value: T): T {
  if (Array.isArray(value)) return value.filter((each) => each !== GONE).map(withoutGone) as T;
  if (!isRecord(value)) return value;
  const fields = Object.entries(value).map(([field, inner]) => [field, withoutGone(inner)]);
  return Object.fromEntries(fields) as T;
}

function putAt(value: unknown, path: SettingPath, to: unknown): unknown {
  const [field, ...rest] = path;
  if (field === undefined) return to;
  if (Array.isArray(value)) {
    // A row past the end comes back after the rows there.
    if (typeof field === 'number' && field >= value.length) return to === undefined ? value : [...value, to];
    return value.map((each, index) => {
      if (index !== field) return each;
      return rest.length === 0 && to === undefined ? GONE : putAt(each, rest, to);
    });
  }
  const next: Record<string, unknown> = { ...(isRecord(value) ? value : {}) };
  const inner = putAt(next[field], rest, to);
  if (inner === undefined) delete next[field];
  else next[field] = inner;
  return next;
}

/**
 * A merge's workspace with the files' value at each conflict named in `theirs`, by its place in
 * `merge.conflicts`. Every other conflict keeps the builder's value.
 */
export function withFilesChosen(merge: FilesMerge, theirs: readonly number[]): StudioWorkspace {
  let { agents, toolSpecs } = merge.workspace;
  const starts = { agents: { ...merge.workspace.starts.agents }, tools: { ...merge.workspace.starts.tools } };
  const settle = <T extends { key: string }>(held: readonly T[], kept: Record<string, T>, conflict: FileConflict) => {
    if (conflict.path.length > 0) {
      return held.map((each) => (each.key === conflict.key ? putAt(each, conflict.path, conflict.theirs) as T : each));
    }
    // The whole agent or tool: the files took it away, or hold one the builder removed.
    if (conflict.theirs === undefined) {
      delete kept[conflict.key];
      return held.filter((each) => each.key !== conflict.key);
    }
    kept[conflict.key] = conflict.theirs as T;
    return [...held, conflict.theirs as T];
  };
  for (const index of new Set(theirs)) {
    const conflict = merge.conflicts[index];
    if (!conflict) continue;
    if (conflict.kind === 'tool') toolSpecs = settle(toolSpecs, starts.tools, conflict);
    else {
      agents = settle(agents, starts.agents, conflict);
      if (conflict.path.length > 0 || conflict.theirs === undefined) continue;
      // An agent that comes back brings the tools that run it, for the agents the files let use them.
      const held = new Set(toolSpecs.map((tool) => tool.key));
      const runIt = merge.files.toolSpecs.filter((tool) =>
        tool.toolType === 'agent' && tool.agentKey === conflict.key && !held.has(tool.key)
      );
      for (const tool of runIt) starts.tools[tool.key] = tool;
      toolSpecs = [...toolSpecs, ...runIt];
      agents = agents.map((agent) => {
        const allowed = merge.files.agents.find((each) => each.key === agent.key)?.tools.allow ?? [];
        const more = runIt.map((tool) => tool.key).filter((key) => allowed.includes(key) && !agent.tools.allow.includes(key));
        return more.length ? { ...agent, tools: { ...agent.tools, allow: [...agent.tools.allow, ...more] } } : agent;
      });
    }
  }
  [agents, toolSpecs] = [withoutGone(agents), withoutGone(toolSpecs)];
  return sound({ ...merge.workspace, agents, toolSpecs, starts });
}

/**
 * Puts one library tool back to its start, for every agent that allows it. Which agents allow it
 * stays as it is. A tool already at its start returns the same workspace.
 */
export function resetLibraryTool(workspace: StudioWorkspace, toolKey: string): StudioWorkspace {
  const start = workspace.starts.tools[toolKey];
  const now = workspace.toolSpecs.find((tool) => tool.key === toolKey);
  if (!start || !now) return workspace;
  const others = workspace.toolSpecs.filter((tool) => tool.key !== toolKey).map((tool) => tool.toolName);
  const tool = { ...start, toolName: freeName(start.toolName, others, (n) => `${start.toolName}_${n}`) };
  if (same(tool, now)) return workspace;
  return { ...workspace, toolSpecs: workspace.toolSpecs.map((each) => (each.key === toolKey ? tool : each)) };
}

function scopeTree(agentKey: string, node: StudioTreeNode): StudioTreeNode {
  return {
    ...node,
    id: agentNodeId(agentKey, node.id),
    children: node.children.map((child) => scopeTree(agentKey, child)),
  };
}

export interface WorkspaceTree {
  /** One root per agent; its tools are picked in its Tools facet, not listed under it. */
  agents: StudioTreeNode[];
  /** The shared library. */
  tools: StudioTreeNode[];
}

/** Beside other agents, one with no id yet is named as an agent, not by its Identity facet. */
function agentRoot(agent: AgentDraft): StudioTreeNode {
  const root = scopeTree(agent.key, studioTree(draftOf(agent, [])));
  return agent.identity.agentId.trim() ? root : { ...root, label: 'New agent' };
}

export function workspaceTree(workspace: StudioWorkspace): WorkspaceTree {
  return {
    agents: workspace.agents.map(agentRoot),
    tools: toolSpecNodes(workspace.toolSpecs),
  };
}
