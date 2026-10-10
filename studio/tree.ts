/** Node ids are what compile issues point at, so a tree, a graph, or a form can place an issue. */

import { PROFILE_GRAPH, type ProfileGraphFacetId } from '../src/kernel/schema.ts';
import { draftFacets, type StudioDraft } from './draft.ts';

export function modelBindingNodeId(key: string): string {
  return `modelBinding:${key}`;
}

const TOOL_SPEC_PREFIX = 'toolSpec:';

export function toolSpecNodeId(key: string): string {
  return `${TOOL_SPEC_PREFIX}${key}`;
}

/** The inverse of `toolSpecNodeId`; `undefined` for any other id. */
export function toolSpecKeyOf(id: string): string | undefined {
  return id.startsWith(TOOL_SPEC_PREFIX) ? id.slice(TOOL_SPEC_PREFIX.length) : undefined;
}

export type StudioNodeRef =
  | { facet: 'modelBinding'; key: string }
  | { facet: 'toolSpec'; key: string }
  | { facet: Exclude<ProfileGraphFacetId, 'modelBinding' | 'toolSpec'> };

export interface StudioTreeNode {
  id: string;
  ref: StudioNodeRef;
  label: string;
  children: StudioTreeNode[];
}

const FACET_LABEL = new Map<string, string>(PROFILE_GRAPH.map((facet) => [facet.id, facet.label]));

function facetLabel(id: ProfileGraphFacetId): string {
  return FACET_LABEL.get(id) ?? id;
}

/** `undefined` when the id names nothing. */
export function studioNodeRef(
  draft: StudioDraft,
  id: string,
): StudioNodeRef | undefined {
  const [facet, key] = id.split(':', 2);
  if (facet === 'modelBinding' && key !== undefined) {
    return draft.modelBindings.some((binding) => binding.key === key) ? { facet, key } : undefined;
  }
  const tool = toolSpecKeyOf(id);
  if (tool !== undefined) {
    return draft.toolSpecs.some((spec) => spec.key === tool) ? { facet: 'toolSpec', key: tool } : undefined;
  }
  const facets = draftFacets(draft) as string[];
  if (key !== undefined || !facets.includes(id)) return undefined;
  return { facet: id as Exclude<ProfileGraphFacetId, 'modelBinding' | 'toolSpec'> };
}

function branchNodes(draft: StudioDraft, facet: ProfileGraphFacetId): StudioTreeNode[] {
  if (facet === 'models') {
    return draft.modelBindings.map((binding) => ({
      id: modelBindingNodeId(binding.key),
      ref: { facet: 'modelBinding', key: binding.key },
      label: binding.modelId.trim() || facetLabel('modelBinding'),
      children: [],
    }));
  }
  if (facet === 'tools') return toolSpecNodes(draft.toolSpecs);
  return [];
}

/** One leaf per tool, as the Tools facet lists them. */
export function toolSpecNodes(toolSpecs: StudioDraft['toolSpecs']): StudioTreeNode[] {
  return toolSpecs.map((tool) => ({
    id: toolSpecNodeId(tool.key),
    ref: { facet: 'toolSpec', key: tool.key },
    label: tool.toolName.trim() || facetLabel('toolSpec'),
    children: [],
  }));
}

/** The root is labelled with the profile id; its children are the compiled facets in `PROFILE_GRAPH` order. */
export function studioTree(draft: StudioDraft): StudioTreeNode {
  const children = draftFacets(draft)
    .filter((facet) => facet !== 'identity')
    .map(
      (facet): StudioTreeNode => ({
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
