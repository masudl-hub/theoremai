/**
 * The draft as a tree: the profile at the root, its spine facets beneath it,
 * and each model binding and custom tool under `models` and `tools`. Node ids
 * are what compile issues point at, so a tree, a graph, or a form can show an
 * issue on the part of the draft it belongs to.
 *
 * @module
 */

import { PROFILE_GRAPH, type ProfileGraphFacetId } from '../src/kernel/schema.ts';
import { draftFacets, type PlaygroundDraft } from './draft.ts';

/** Id of the node for one model binding. */
export function modelBindingNodeId(key: string): string {
  return `modelBinding:${key}`;
}

/** Id of the node for one custom tool. */
export function toolSpecNodeId(key: string): string {
  return `toolSpec:${key}`;
}

/** Which part of the draft a node id names. */
export type PlaygroundNodeRef =
  | { facet: 'modelBinding'; key: string }
  | { facet: 'toolSpec'; key: string }
  | { facet: Exclude<ProfileGraphFacetId, 'modelBinding' | 'toolSpec'> };

export interface PlaygroundTreeNode {
  id: string;
  ref: PlaygroundNodeRef;
  label: string;
  children: PlaygroundTreeNode[];
}

const FACET_LABEL = new Map<string, string>(PROFILE_GRAPH.map((facet) => [facet.id, facet.label]));

function facetLabel(id: ProfileGraphFacetId): string {
  return FACET_LABEL.get(id) ?? id;
}

/** Resolve a node id back to the draft part it names; `undefined` when it names nothing. */
export function playgroundNodeRef(
  draft: PlaygroundDraft,
  id: string,
): PlaygroundNodeRef | undefined {
  const [facet, key] = id.split(':', 2);
  if (facet === 'modelBinding' && key !== undefined) {
    return draft.modelBindings.some((binding) => binding.key === key) ? { facet, key } : undefined;
  }
  if (facet === 'toolSpec' && key !== undefined) {
    return draft.toolSpecs.some((tool) => tool.key === key) ? { facet, key } : undefined;
  }
  const facets = draftFacets(draft) as string[];
  if (key !== undefined || !facets.includes(id)) return undefined;
  return { facet: id as Exclude<ProfileGraphFacetId, 'modelBinding' | 'toolSpec'> };
}

function branchNodes(draft: PlaygroundDraft, facet: ProfileGraphFacetId): PlaygroundTreeNode[] {
  if (facet === 'models') {
    return draft.modelBindings.map((binding) => ({
      id: modelBindingNodeId(binding.key),
      ref: { facet: 'modelBinding', key: binding.key },
      label: binding.modelId.trim() || facetLabel('modelBinding'),
      children: [],
    }));
  }
  if (facet === 'tools') {
    return draft.toolSpecs.map((tool) => ({
      id: toolSpecNodeId(tool.key),
      ref: { facet: 'toolSpec', key: tool.key },
      label: tool.toolName.trim() || facetLabel('toolSpec'),
      children: [],
    }));
  }
  return [];
}

/**
 * The draft's tree: one root (the profile, labelled with its id) whose children
 * are the facets the draft compiles, in `PROFILE_GRAPH` order.
 */
export function playgroundTree(draft: PlaygroundDraft): PlaygroundTreeNode {
  const children = draftFacets(draft)
    .filter((facet) => facet !== 'identity')
    .map(
      (facet): PlaygroundTreeNode => ({
        id: facet,
        ref: { facet: facet as Exclude<ProfileGraphFacetId, 'modelBinding' | 'toolSpec'> },
        label: facetLabel(facet),
        children: branchNodes(draft, facet),
      }),
    );
  return {
    id: 'identity',
    ref: { facet: 'identity' },
    label: draft.identity.agentId.trim() || facetLabel('identity'),
    children,
  };
}
