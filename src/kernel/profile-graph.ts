import { ALL_PROFILE_TYPES, profileTypesForField } from './profile-scope.ts';
import type { ProfileType } from './schema.ts';

export type ProfileGraphEditor = 'schema' | 'structural';

export type ProfileGraphRole = 'root' | 'spine' | 'branch';

interface ProfileGraphFacetDef {
  readonly id: string;
  readonly profilePath: string;
  readonly role: ProfileGraphRole;
  readonly parent?: string;
  readonly optional: boolean;
  readonly editor: ProfileGraphEditor;
  readonly label: string;
  readonly ownsFields?: readonly string[];
}

/**
 * Adding a profile section? Add it to PROFILE_FIELDS and a row here, never a FacetKind in the
 * frontend. Each facet's `profileTypes` come from `PROFILE_FIELD_SCOPE` via its `profilePath`.
 */
const PROFILE_GRAPH_DEF = [
  {
    id: 'identity',
    profilePath: 'identity',
    role: 'root',
    optional: false,
    editor: 'structural',
    label: 'Identity',
    ownsFields: ['id', 'type'],
  },
  {
    id: 'models',
    profilePath: 'models',
    role: 'spine',
    optional: false,
    editor: 'structural',
    label: 'Models',
    ownsFields: ['defaultModel', 'allowModelSelect', 'maxSteps', 'key'],
  },
  {
    id: 'modelBinding',
    profilePath: 'models.*',
    role: 'branch',
    parent: 'models',
    optional: false,
    editor: 'structural',
    label: 'Model binding',
  },
  {
    id: 'decision',
    profilePath: 'decision',
    role: 'spine',
    optional: false,
    editor: 'structural',
    label: 'Decision',
    ownsFields: ['inputs'],
  },
  {
    id: 'image',
    profilePath: 'image',
    role: 'spine',
    optional: false,
    editor: 'structural',
    label: 'Image',
  },
  {
    id: 'speech',
    profilePath: 'speech',
    role: 'spine',
    optional: false,
    editor: 'structural',
    label: 'Speech',
  },
  {
    id: 'live',
    profilePath: 'live',
    role: 'spine',
    optional: false,
    editor: 'structural',
    label: 'Live',
  },
  {
    id: 'tools',
    profilePath: 'tools',
    role: 'spine',
    optional: false,
    editor: 'structural',
    label: 'Tools',
  },
  {
    id: 'toolSpec',
    profilePath: 'tools.allow',
    role: 'branch',
    parent: 'tools',
    optional: true,
    editor: 'structural',
    label: 'Tool',
  },
  {
    id: 'inputs',
    profilePath: 'inputs',
    role: 'spine',
    optional: false,
    editor: 'structural',
    label: 'Inputs',
  },
  {
    id: 'outputs',
    profilePath: 'outputs',
    role: 'spine',
    optional: true,
    editor: 'structural',
    label: 'Outputs',
  },
  {
    id: 'turnBehaviour',
    profilePath: 'turnBehaviour',
    role: 'spine',
    optional: true,
    editor: 'structural',
    label: 'Turn behaviour',
  },
  {
    id: 'guardrails',
    profilePath: 'guardrails',
    role: 'spine',
    optional: true,
    editor: 'structural',
    label: 'Guardrails',
  },
  {
    id: 'observability',
    profilePath: 'observability',
    role: 'spine',
    optional: true,
    editor: 'structural',
    label: 'Observability',
  },
  {
    id: 'wording',
    profilePath: 'lexicon',
    role: 'spine',
    optional: true,
    editor: 'structural',
    label: 'Wording',
  },
] as const satisfies readonly ProfileGraphFacetDef[];

export type ProfileGraphFacetId = (typeof PROFILE_GRAPH_DEF)[number]['id'];

/** `profilePath` is a PROFILE_FIELDS key (section root) or a dynamic path (`models.*`). */
export interface ProfileGraphFacet {
  id: ProfileGraphFacetId;
  profilePath: string;
  role: ProfileGraphRole;
  parent?: ProfileGraphFacetId;
  profileTypes: readonly ProfileType[];
  optional: boolean;
  editor: ProfileGraphEditor;
  label: string;
  /**
   * Extra PROFILE_FIELDS top-level keys owned by this facet (not 1:1 with id).
   * Used by the drift gate so `defaultModel` / `id` / `type` are not orphaned.
   */
  ownsFields?: readonly string[];
}

/** The facets whose types differ from their `profilePath`'s scope. */
const FACET_PROFILE_TYPES: Partial<Record<ProfileGraphFacetId, readonly ProfileType[]>> = {
  // The root holds `id` and `type`, which every profile has.
  identity: ALL_PROFILE_TYPES,
  // A decision's inputs belong to its Decision facet.
  inputs: profileTypesForField('inputs').filter((type) => type !== 'decision'),
};

export const PROFILE_GRAPH: readonly ProfileGraphFacet[] = PROFILE_GRAPH_DEF.map((facet) => ({
  ...facet,
  profileTypes: FACET_PROFILE_TYPES[facet.id] ?? profileTypesForField(facet.profilePath),
}));

/** Spine (and root) facets visible for a profile type, in catalog order. */
function spineFacetsForProfileType(type: ProfileType): ProfileGraphFacet[] {
  return PROFILE_GRAPH.filter(
    (facet) =>
      (facet.role === 'root' || facet.role === 'spine') && facet.profileTypes.includes(type),
  );
}

function profileGraphFacet(id: ProfileGraphFacetId): ProfileGraphFacet | undefined {
  return PROFILE_GRAPH.find((facet) => facet.id === id);
}

export { profileGraphFacet, spineFacetsForProfileType };
