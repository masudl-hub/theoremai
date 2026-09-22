/**
 * Profile graph — playground / authoring topology projected from PROFILE_FIELDS.
 *
 * This is not runtime policy. It declares which profile sections are graph
 * facets, for which ProfileType, whether they may be omitted, and whether the
 * host UI uses a schema form or a structural editor. The playground must import
 * this catalog; it must not invent FacetKind unions.
 *
 * @module
 */

import type { ProfileType } from './schema.ts';

/** How the playground (or other host UI) should edit this facet. */
export type ProfileGraphEditor = 'schema' | 'structural';

/** Where the facet sits in the authoring graph. */
export type ProfileGraphRole = 'root' | 'spine' | 'branch';

/**
 * Base definition shape — `id` and `parent` are narrowed via `as const`;
 * the public `ProfileGraphFacetId` type is derived, never hand-maintained.
 */
interface ProfileGraphFacetDef {
  readonly id: string;
  readonly profilePath: string;
  readonly role: ProfileGraphRole;
  readonly parent?: string;
  readonly profileTypes: readonly ProfileType[];
  readonly optional: boolean;
  readonly editor: ProfileGraphEditor;
  readonly label: string;
  readonly ownsFields?: readonly string[];
}

/**
 * Mirrors PROFILE_TYPES — value import would cycle through schema re-exports.
 * Drift is gated by tests/kernel/profile-graph.test.ts.
 */
const ALL: readonly ProfileType[] = ['text', 'image', 'speech', 'live', 'host'];

/** Types that bind models — `host` never runs a model. */
const MODEL_TYPES: readonly ProfileType[] = ['text', 'image', 'speech', 'live'];

/**
 * Authoring-graph catalog. Adding a profile section? Add PROFILE_FIELDS and a row
 * here — never a FacetKind in the frontend.
 *
 * `ProfileGraphFacetId` is derived from this array; do not maintain a union by hand.
 */
const PROFILE_GRAPH_DEF = [
  {
    id: 'identity',
    profilePath: 'identity',
    role: 'root',
    profileTypes: ALL,
    optional: false,
    editor: 'structural',
    label: 'Identity',
    ownsFields: ['id', 'type'],
  },
  {
    id: 'models',
    profilePath: 'models',
    role: 'spine',
    profileTypes: MODEL_TYPES,
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
    profileTypes: MODEL_TYPES,
    optional: false,
    editor: 'structural',
    label: 'Model binding',
  },
  {
    id: 'image',
    profilePath: 'image',
    role: 'spine',
    profileTypes: ['image'],
    optional: false,
    editor: 'structural',
    label: 'Image',
  },
  {
    id: 'speech',
    profilePath: 'speech',
    role: 'spine',
    profileTypes: ['speech'],
    optional: false,
    editor: 'structural',
    label: 'Speech',
  },
  {
    id: 'live',
    profilePath: 'live',
    role: 'spine',
    profileTypes: ['live'],
    optional: false,
    editor: 'structural',
    label: 'Live',
  },
  {
    id: 'tools',
    profilePath: 'tools',
    role: 'spine',
    profileTypes: ['text', 'image', 'live', 'host'],
    optional: false,
    editor: 'structural',
    label: 'Tools',
  },
  {
    id: 'toolSpec',
    profilePath: 'tools.allow',
    role: 'branch',
    parent: 'tools',
    profileTypes: ['text', 'image', 'live', 'host'],
    optional: true,
    editor: 'structural',
    label: 'Tool',
  },
  {
    id: 'inputs',
    profilePath: 'inputs',
    role: 'spine',
    profileTypes: ['text', 'image'],
    optional: false,
    editor: 'structural',
    label: 'Inputs',
  },
  {
    id: 'outputs',
    profilePath: 'outputs',
    role: 'spine',
    profileTypes: ['text', 'image', 'speech'],
    optional: true,
    editor: 'structural',
    label: 'Outputs',
  },
  {
    id: 'turnBehaviour',
    profilePath: 'turnBehaviour',
    role: 'spine',
    profileTypes: ['text', 'image', 'speech', 'live'],
    optional: true,
    editor: 'structural',
    label: 'Turn behaviour',
  },
  {
    id: 'guardrails',
    profilePath: 'guardrails',
    role: 'spine',
    profileTypes: ALL,
    optional: true,
    editor: 'structural',
    label: 'Guardrails',
  },
  {
    id: 'observability',
    profilePath: 'observability',
    role: 'spine',
    profileTypes: ALL,
    optional: true,
    editor: 'structural',
    label: 'Observability',
  },
] as const satisfies readonly ProfileGraphFacetDef[];

/** Stable facet ids — derived from PROFILE_GRAPH; never hand-maintained. */
export type ProfileGraphFacetId = (typeof PROFILE_GRAPH_DEF)[number]['id'];

/**
 * One node kind on the profile authoring graph.
 *
 * `profilePath` is a PROFILE_FIELDS key (section root) or a dynamic path
 * (`models.*`). Branch facets nest under `parent`.
 */
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

/**
 * Immutable profile-editor catalog. Hosts can use it to render compatible facets
 * and detect profile-field drift without duplicating the kernel's structure.
 */
export const PROFILE_GRAPH: readonly ProfileGraphFacet[] = PROFILE_GRAPH_DEF;

/** Spine (and root) facets visible for a profile type, in catalog order. */
function spineFacetsForProfileType(type: ProfileType): ProfileGraphFacet[] {
  return PROFILE_GRAPH.filter(
    (facet) =>
      (facet.role === 'root' || facet.role === 'spine') && facet.profileTypes.includes(type),
  );
}

/** Look up a graph facet by id. */
function profileGraphFacet(id: ProfileGraphFacetId): ProfileGraphFacet | undefined {
  return PROFILE_GRAPH.find((facet) => facet.id === id);
}

export { profileGraphFacet, spineFacetsForProfileType };
