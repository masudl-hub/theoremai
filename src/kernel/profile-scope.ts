// Leaf module: `schema.ts` and `profile-graph.ts` read it at load time.

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

const MODEL_PROFILE_TYPES: readonly ProfileType[] = ['text', 'image', 'speech', 'live', 'decision'];

const TURN_TYPES: readonly ProfileType[] = ['text', 'image', 'speech', 'live'];

/** Types whose `inputs` are turn inputs (text, files, slots) rather than decision state. */
const TURN_INPUT_TYPES: readonly ProfileType[] = ['text', 'image'];

const TURN_INPUT_REASON = 'a decision takes JSON state, not turn text, files or slots';

export interface ProfileFieldScope {
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

/** Keyed like `PROFILE_FIELDS`; `models.*` matches every model binding. */
export const PROFILE_FIELD_SCOPE: Readonly<Record<string, ProfileFieldScope>> = {
  identity: {
    profileTypes: MODEL_PROFILE_TYPES,
    reason: 'a host profile has no agent identity — it runs no model',
  },
  'identity.system': {
    profileTypes: ['text', 'image', 'live'],
    reason:
      'speech has no system channel (the input text is the transcript) and a decision is asked only through its questions',
  },
  'identity.systemByRole': {
    profileTypes: ['text', 'image', 'live'],
    reason:
      'speech has no system channel (the input text is the transcript) and a decision is asked only through its questions',
  },
  models: { profileTypes: MODEL_PROFILE_TYPES, reason: 'a host profile runs no model' },
  'models.*.protocol': {
    profileTypes: TURN_TYPES,
    reason: 'a decision binds its model by apiId alone',
  },
  'models.*.provider': {
    profileTypes: TURN_TYPES,
    reason: 'a decision binds its model by apiId alone',
  },
  'models.*.compaction': {
    profileTypes: ['text', 'image', 'speech'],
    reason: 'live compacts with live.contextCompression',
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
  'inputs.voice': {
    profileTypes: ['text'],
    reason: 'no image model reads audio, and a decision takes JSON state',
  },
  'inputs.text': {
    profileTypes: TURN_INPUT_TYPES,
    reason: TURN_INPUT_REASON,
  },
  'inputs.attachments': {
    profileTypes: TURN_INPUT_TYPES,
    reason: TURN_INPUT_REASON,
  },
  'inputs.maxFiles': {
    profileTypes: TURN_INPUT_TYPES,
    reason: TURN_INPUT_REASON,
  },
  'inputs.maxBytes': {
    profileTypes: TURN_INPUT_TYPES,
    reason: TURN_INPUT_REASON,
  },
  'inputs.maxTurnBytes': {
    profileTypes: TURN_INPUT_TYPES,
    reason: TURN_INPUT_REASON,
  },
  'inputs.limitsByMime': {
    profileTypes: TURN_INPUT_TYPES,
    reason: TURN_INPUT_REASON,
  },
  'inputs.slots': {
    profileTypes: TURN_INPUT_TYPES,
    reason: TURN_INPUT_REASON,
  },
  'inputs.state': {
    profileTypes: ['decision'],
    reason: 'only a decision reads JSON state; a turn takes text, files and slots',
  },
  'inputs.maxStateBytes': {
    profileTypes: ['decision'],
    reason: 'only a decision reads JSON state; a turn takes text, files and slots',
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

export function profileTypesForField(path: string): readonly ProfileType[] {
  return profileFieldScope(path)?.profileTypes ?? ALL_PROFILE_TYPES;
}

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
