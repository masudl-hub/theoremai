/**
 * Which profile types each profile field belongs to — the one owner of that fact.
 *
 * `defineProfile` enforces it, `PROFILE_FIELDS` exposes it on every field's
 * `FieldMeta`, and `PROFILE_GRAPH` takes its facets' types from it, so an
 * authoring UI projects the same rule the kernel enforces. A path with no entry
 * inherits its nearest ancestor's scope; a path with none at all belongs to
 * every type.
 *
 * Leaf module: `schema.ts` and `profile-graph.ts` both read it at load time.
 *
 * @module
 */

/** lexicon-exempt-file: authoring field-meta scope reasons — not runtime user or model copy (P2) */

import { HOST_GUARDRAIL_FIELDS } from '../guardrails/types.ts';
import type { ProfileType } from './schema.ts';

/**
 * Mirrors `PROFILE_TYPES` — a value import would cycle through `schema.ts`.
 * Drift is gated by tests/kernel/profile-scope.test.ts.
 */
export const ALL_PROFILE_TYPES: readonly ProfileType[] = [
  'text',
  'image',
  'speech',
  'live',
  'decision',
  'host',
];

/** Types that bind models — `host` never runs a model. */
const MODEL_PROFILE_TYPES: readonly ProfileType[] = ['text', 'image', 'speech', 'live', 'decision'];

/** Types that run a model turn: everything but `decision` and `host`. */
const TURN_TYPES: readonly ProfileType[] = ['text', 'image', 'speech', 'live'];

export interface ProfileFieldScope {
  /** The profile types the field may be set on. */
  profileTypes: readonly ProfileType[];
  /** Why other types can't take it — shown in `defineProfile` errors and authoring UIs. */
  reason: string;
  /**
   * The one value other types may still carry: the field's "off" value, which
   * `defineProfile` itself writes (speech stores `guardrails.canary: false`).
   */
  offValue?: false;
}

/** Guardrails a host profile may set keep `host`; the rest guard a model turn. */
function turnGuardrailTypes(key: string): readonly ProfileType[] {
  return (HOST_GUARDRAIL_FIELDS as readonly string[]).includes(key)
    ? [...TURN_TYPES, 'host']
    : TURN_TYPES;
}

/**
 * Profile paths scoped to some profile types, keyed like `PROFILE_FIELDS`
 * (`models.*` matches every model binding).
 */
export const PROFILE_FIELD_SCOPE: Readonly<Record<string, ProfileFieldScope>> = {
  identity: {
    profileTypes: MODEL_PROFILE_TYPES,
    reason: 'a host profile has no agent identity — it runs no model',
  },
  'identity.system': {
    profileTypes: ['text', 'image', 'live'],
    reason:
      'speech has no system channel (the input text is the transcript) and a decision prompts through decision.contract',
  },
  'identity.systemByRole': {
    profileTypes: ['text', 'image', 'live'],
    reason:
      'speech has no system channel (the input text is the transcript) and a decision prompts through decision.contract',
  },
  models: { profileTypes: MODEL_PROFILE_TYPES, reason: 'a host profile runs no model' },
  'models.*.compaction': {
    profileTypes: ['text'],
    reason: 'only text turns keep a history to compact',
  },
  key: { profileTypes: MODEL_PROFILE_TYPES, reason: 'a host profile runs no model' },
  defaultModel: {
    profileTypes: TURN_TYPES,
    reason: 'a host profile runs no model and a decision declares exactly one',
  },
  allowModelSelect: {
    profileTypes: TURN_TYPES,
    reason: 'a host profile runs no model and a decision declares exactly one',
  },
  maxSteps: {
    profileTypes: TURN_TYPES,
    reason: 'only model turns take tool-loop steps',
  },
  decision: { profileTypes: ['decision'], reason: 'only decision profiles carry a contract' },
  image: { profileTypes: ['image'], reason: 'only image profiles generate images' },
  speech: { profileTypes: ['speech'], reason: 'only speech profiles synthesize audio' },
  live: { profileTypes: ['live'], reason: 'only live profiles open a realtime session' },
  tools: {
    profileTypes: ['text', 'image', 'live', 'host'],
    reason: 'speech and decision profiles call no tools',
  },
  'tools.t1Policy': {
    profileTypes: ['text', 'image'],
    reason:
      'live wires every allowed tool once at session setup, and a host profile can execute every allowed tool',
  },
  'tools.t2Loader': {
    profileTypes: ['text', 'image'],
    reason:
      'live function declarations are fixed at session setup, and a host profile can execute every allowed tool',
  },
  inputs: {
    profileTypes: ['text', 'image', 'decision'],
    reason:
      'speech input is the transcript, live ingress is live.ingress, and a host profile takes no turns',
  },
  outputs: {
    profileTypes: ['text', 'image', 'speech'],
    reason:
      'live output is the realtime session, and decision and host profiles produce no turn output',
  },
  turnBehaviour: {
    profileTypes: TURN_TYPES,
    reason: 'only model turns can be continued or steered',
  },
  'turnBehaviour.resumption': {
    profileTypes: ['text', 'image', 'speech'],
    reason: 'live resumes through live.sessionResumption',
  },
  'turnBehaviour.resumption.continueInstruction': {
    profileTypes: ['text'],
    reason: 'image and speech continue by re-sending the request',
  },
  'turnBehaviour.allowSteering': {
    profileTypes: ['text', 'live'],
    reason: 'image and speech turns take no mid-turn input',
  },
  'guardrails.quota': {
    profileTypes: turnGuardrailTypes('quota'),
    reason: 'quota counts model turns',
  },
  'guardrails.canary': {
    profileTypes: ['text', 'image', 'live'],
    reason:
      'the canary is minted into a system prompt, which speech, decision and host profiles lack',
    offValue: false,
  },
  'guardrails.sanitizeInput': {
    profileTypes: turnGuardrailTypes('sanitizeInput'),
    reason: 'the decision path runs none of the turn guardrails',
  },
  'guardrails.redactSensitive': {
    profileTypes: turnGuardrailTypes('redactSensitive'),
    reason: 'the decision path runs none of the turn guardrails',
  },
  'guardrails.egress': {
    profileTypes: turnGuardrailTypes('egress'),
    reason: 'egress gates user-visible model text in the turn runner',
  },
  'guardrails.network': {
    profileTypes: turnGuardrailTypes('network'),
    reason: 'the decision path calls no tools',
  },
  'guardrails.taint': {
    profileTypes: turnGuardrailTypes('taint'),
    reason: 'the decision path calls no tools',
  },
  'guardrails.disclosure': {
    profileTypes: ['decision'],
    reason: 'disclosure gates state leaving a decision profile for its model',
  },
};

/**
 * The scope entry that governs `path`: its own, else its nearest ancestor's.
 * `undefined` means every profile type.
 */
export function profileFieldScope(path: string): ProfileFieldScope | undefined {
  const segments = path.split('.');
  for (let end = segments.length; end > 0; end--) {
    const scope = PROFILE_FIELD_SCOPE[segments.slice(0, end).join('.')];
    if (scope) return scope;
  }
  return undefined;
}

/** The profile types `path` may be set on. */
export function profileTypesForField(path: string): readonly ProfileType[] {
  return profileFieldScope(path)?.profileTypes ?? ALL_PROFILE_TYPES;
}

/** A field set on a profile type outside its scope, at its concrete path. */
export interface OutOfScopeField {
  /** e.g. `models.fast.compaction` for the `models.*.compaction` scope. */
  path: string;
  scope: ProfileFieldScope;
}

/** Every set value under `segments`, keyed by concrete path; `*` walks each key of a map. */
function valuesAt(root: unknown, segments: readonly string[], at = ''): [string, unknown][] {
  if (!segments.length) return root === undefined ? [] : [[at, root]];
  if (root === null || typeof root !== 'object') return [];
  const [head, ...rest] = segments;
  const record = root as Record<string, unknown>;
  const keys = head === '*' ? Object.keys(record) : [head];
  return keys.flatMap((key) => valuesAt(record[key], rest, at ? `${at}.${key}` : key));
}

/**
 * Every field `profile` sets that its type may not, ancestors before their
 * children. A scope's off value is not reported.
 */
export function outOfScopeFields(profile: { readonly type: ProfileType }): OutOfScopeField[] {
  const out: OutOfScopeField[] = [];
  for (const [path, scope] of Object.entries(PROFILE_FIELD_SCOPE)) {
    if (scope.profileTypes.includes(profile.type)) continue;
    for (const [at, value] of valuesAt(profile, path.split('.'))) {
      if (scope.offValue !== undefined && value === scope.offValue) continue;
      out.push({ path: at, scope });
    }
  }
  return out;
}
