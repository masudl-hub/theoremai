/**
 * The project's shared settings as the studio's workspace holds them: which
 * agents share each one, and the section of an agent it fills.
 *
 * @module
 */

import { PROFILE_GRAPH, type ProfileGraphFacetId } from '../src/kernel/schema.ts';
import type { SharedSetting } from './server/save-wire.ts';
import { modelBindingNodeId } from './tree.ts';
import { agentNodeId, type StudioWorkspace } from './workspace.ts';

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
}

/** The section whose whole value is the profile key `key`. */
function facetOf(key: string | undefined): ProfileGraphFacetId | undefined {
  return PROFILE_GRAPH.find((facet) => facet.role === 'spine' && facet.profilePath === key)?.id;
}

/** Each shared setting with the agents that share it, as the project opened. */
export function sharedEntries(workspace: StudioWorkspace, settings: readonly SharedSetting[]): SharedEntry[] {
  return settings.map((setting) => {
    const agents = workspace.agents
      .filter((agent) => setting.profiles.includes(agent.identity.agentId.trim()))
      .map((agent) => agent.key);
    const facet = agents.length === setting.profiles.length ? facetOf(setting.key) : undefined;
    return { setting, agents, ...(facet ? { facet } : {}) };
  });
}

/** The node that opens a shared setting on one of its agents. */
export function sharedNodeId(entry: SharedEntry, agentKey: string): string {
  return agentNodeId(agentKey, entry.facet ?? 'identity');
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
