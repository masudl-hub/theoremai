/**
 * The project's shared settings as the studio's workspace holds them: which
 * agents share each one, and the section of an agent it fills.
 *
 * @module
 */

import { PROFILE_GRAPH, type ProfileGraphFacetId } from '@theoremjs/agents/schema';
import type { ProjectOrigins, SharedSetting, Unregistered } from './server/save-wire.ts';
import { modelBindingNodeId, toolSpecNodeId } from './tree.ts';
import { type AgentDraft, agentNodeId, type StudioWorkspace, workspaceTree } from './workspace.ts';

/** One shared setting, beside the agents of the workspace that share it. */
export interface SharedEntry {
  setting: SharedSetting;
  /** The agents that share it, by key, in the workspace's order. */
  agents: string[];
  /**
   * The section the studio edits it in. Unset when the constant is not the whole of one section in
   * every profile, or a profile that reads it is not open: then it is changed in the builder's editor.
   */
  facet?: ProfileGraphFacetId;
  /** Where each agent shows the value: the node that holds the field the files set from it, by agent key. */
  places: Record<string, string>;
  /** The tool that shows the value, when no agent does. */
  tool?: string;
  /** The profiles and tools that read it and that the project did not register, so nothing opens them. */
  idle: Unregistered[];
}

/** The node of `agent` that holds the setting at `path`: its model, its section, else the agent. */
function nodeAt(agent: AgentDraft, path: readonly string[], sections: ReadonlySet<string>): string {
  const [head, name] = path;
  const binding = head === 'models' ? agent.modelBindings.find((each) => each.modelId === name) : undefined;
  if (binding) return agentNodeId(agent.key, modelBindingNodeId(binding.key));
  const facet = PROFILE_GRAPH.find((each) => each.role === 'spine' && each.profilePath === head)?.id;
  const section = facet ? agentNodeId(agent.key, facet) : '';
  return sections.has(section) ? section : agentNodeId(agent.key);
}

/** The section whose whole value is the profile key `key`. */
function facetOf(key: string | undefined): ProfileGraphFacetId | undefined {
  return PROFILE_GRAPH.find((facet) => facet.role === 'spine' && facet.profilePath === key)?.id;
}

/** Each shared setting with the agents that share it, as the project opened. */
export function sharedEntries(
  workspace: StudioWorkspace,
  settings: readonly SharedSetting[],
  sites?: ProjectOrigins['sites'],
  unregistered: readonly Unregistered[] = [],
): SharedEntry[] {
  const sections = new Set(workspaceTree(workspace).agents.flatMap((agent) => agent.children ?? []).map((row) => row.id));
  return settings.map((setting) => {
    const users = workspace.agents.filter((agent) => setting.profiles.includes(agent.identity.agentId.trim()));
    const agents = users.map((agent) => agent.key);
    const facet = agents.length === setting.profiles.length ? facetOf(setting.key) : undefined;
    const written = (held: Record<string, readonly { name?: string; file: string; path: string[] }[]> | undefined, id: string) =>
      held?.[id]?.find((site) => site.name === setting.name && site.file === setting.file);
    const places = Object.fromEntries(users.flatMap((agent) => {
      const site = written(sites?.profiles, agent.identity.agentId.trim());
      return site ? [[agent.key, nodeAt(agent, site.path, sections)] as const] : [];
    }));
    const tool = workspace.toolSpecs.find((spec) => written(sites?.tools, spec.toolName));
    const idle = unregistered.filter(({ kind, name }) => (kind === 'profile' ? setting.profiles : setting.tools).includes(name));
    return { setting, agents, places, idle, ...(facet ? { facet } : {}), ...(tool ? { tool: toolSpecNodeId(tool.key) } : {}) };
  });
}

/** The node that opens a shared setting on one of its agents: the field the files set from it. */
export function sharedNodeId(entry: SharedEntry, agentKey: string): string {
  return entry.places[agentKey] ?? agentNodeId(agentKey, entry.facet ?? 'identity');
}

/** The node that opens a shared setting: the first agent that shows it, else the tool that does. */
export function sharedOpens(entry: SharedEntry): string | undefined {
  const shown = entry.agents.find((key) => entry.places[key] !== undefined) ?? (entry.facet ? entry.agents[0] : undefined);
  return shown ? sharedNodeId(entry, shown) : entry.tool;
}

/** The shared setting the open node edits, when it is one. A shared `models` is edited in each binding. */
export function sharedAt(entries: readonly SharedEntry[], nodeId: string): SharedEntry | undefined {
  return entries.find(({ facet, agents }) =>
    facet !== undefined && agents.some((key) => {
      const root = `${agentNodeId(key)}/`;
      if (!nodeId.startsWith(root)) return false;
      const inner = nodeId.slice(root.length);
      return inner === facet || (facet === 'models' && inner.startsWith(modelBindingNodeId('')));
    })
  );
}
