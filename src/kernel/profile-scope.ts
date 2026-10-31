// invariant: Leaf module: `schema.ts` and `profile-graph.ts` read it at load time.
/** labels-exempt-file: authoring field-meta scope reasons — not runtime user or model copy (P2) */
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
  'transcription',
  'live',
  'decision',
  'embedding',
  'host',
];
const MODEL_PROFILE_TYPES: readonly ProfileType[] = [
  'text',
  'image',
  'speech',
  'transcription',
  'live',
  'decision',
  'embedding',
];
const TURN_TYPES: readonly ProfileType[] = ['text', 'image', 'speech', 'live'];
/** Types whose `inputs` are turn inputs (text, files, slots) rather than decision state. */
const TURN_INPUT_TYPES: readonly ProfileType[] = ['text', 'image'];
const TURN_INPUT_REASON =
  'a decision takes JSON state, live takes its input through live.ingress, and transcription takes only a clip';
/** Types that take slots and context: the turn types, and a call. */
const SLOT_TYPES: readonly ProfileType[] = ['text', 'image', 'live'];
const SLOT_REASON =
  'a decision takes JSON state, and transcription and embedding calls take their input alone';
export interface ProfileFieldScope {
  profileTypes: readonly ProfileType[];
  /** Why other types can't take it — shown in `defineProfile` errors and authoring UIs. */
  reason: string;
  /**
   * The one value other types may still carry: the field's "off" value
   * (`outputs.structured: null` asks for no schema).
   */
  offValue?: null;
}
/** Guardrails a host profile may set keep `host`; the rest guard a model turn. */
function turnGuardrailTypes(key: string): readonly ProfileType[] {
  return (HOST_GUARDRAIL_FIELDS as readonly string[]).includes(key)
    ? [...TURN_TYPES, 'transcription', 'host']
    : [...TURN_TYPES, 'transcription'];
}
/**
 * The profile's own settings, which no section holds. The catalog names each `profile.<key>`, as
 * a section's fields carry their section's name.
 */
const PROFILE_ROOT_FIELDS = ['id', 'type', 'defaultModel', 'allowModelSelect', 'maxSteps'] as const;
/** Whether a top-level profile key is one of the profile's own settings. */
export function isProfileRootField(key: string): boolean {
  return (PROFILE_ROOT_FIELDS as readonly string[]).includes(key);
}
/** The keys of the profile object that a catalog path names: `profile.maxSteps` is `maxSteps`. */
export function profileKeysOf(catalogPath: string): string[] {
  return catalogPath.replace(/^profile\./, '').split('.');
}
/** Keyed like `PROFILE_FIELDS`; `models.*` matches every model binding. */
export const PROFILE_FIELD_SCOPE: Readonly<Record<string, ProfileFieldScope>> = {
  providerContinuation: {
    profileTypes: TURN_TYPES,
    reason: 'only model turns and live sessions use provider continuation',
  },
  ...Object.fromEntries(
    [
      'efforts',
      'defaultEffort',
      'allowEffortSelect',
      'summaries',
      'maxOutputTokens',
      'temperature',
      'builtInTools',
    ].map((field) => [
      `models.*.${field}`,
      {
        profileTypes: TURN_TYPES,
        reason: 'only model turns use this setting; decisions send state and questions',
      },
    ]),
  ),
  'models.*.timeoutMs': {
    profileTypes: ['decision'],
    reason: 'only decision bindings configure a request timeout here',
  },
  identity: {
    profileTypes: MODEL_PROFILE_TYPES,
    reason: 'a host profile has no agent identity — it runs no model',
  },
  'identity.conditions': {
    profileTypes: ['text', 'image', 'live'],
    reason:
      'speech has no system channel (the input text is the transcript), a decision is asked only through its questions, and an embedding call embeds its input alone',
  },
  'identity.system': {
    profileTypes: ['text', 'image', 'live'],
    reason:
      'speech has no system channel (the input text is the transcript), a decision is asked only through its questions, and an embedding call embeds its input alone',
  },
  models: { profileTypes: MODEL_PROFILE_TYPES, reason: 'a host profile runs no model' },
  'models.*.protocol': {
    profileTypes: MODEL_PROFILE_TYPES,
    reason: 'a host profile runs no model',
  },
  'models.*.provider': {
    profileTypes: MODEL_PROFILE_TYPES,
    reason: 'a host profile runs no model',
  },
  'models.*.compaction': {
    profileTypes: ['text', 'image', 'speech'],
    reason:
      'live compacts with live.contextCompression, and transcription, decision, and embedding calls keep no conversation to compact',
  },
  'profile.defaultModel': {
    profileTypes: [...TURN_TYPES, 'transcription', 'embedding'],
    reason: 'a host profile runs no model and a decision declares exactly one',
  },
  'profile.allowModelSelect': {
    profileTypes: [...TURN_TYPES, 'transcription', 'embedding'],
    reason: 'a host profile runs no model and a decision declares exactly one',
  },
  'profile.maxSteps': {
    profileTypes: TURN_TYPES,
    reason: 'only model turns take tool-loop steps',
  },
  decision: { profileTypes: ['decision'], reason: 'only decision profiles carry a contract' },
  image: { profileTypes: ['image'], reason: 'only image profiles generate images' },
  speech: { profileTypes: ['speech'], reason: 'only speech profiles synthesize audio' },
  live: { profileTypes: ['live'], reason: 'only live profiles open a realtime session' },
  tools: {
    profileTypes: ['text', 'image', 'live', 'host'],
    reason: 'speech, transcription, decision, and embedding profiles call no tools',
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
    profileTypes: ['text', 'image', 'transcription', 'live', 'decision', 'embedding'],
    reason: 'speech input is the transcript, and a host profile takes no turns',
  },
  'inputs.voice': {
    profileTypes: ['text', 'transcription'],
    reason:
      'no image model reads audio, live takes audio through live.ingress, a decision takes JSON state, and an embedding call takes text and files',
  },
  'inputs.text': {
    profileTypes: [...TURN_INPUT_TYPES, 'transcription', 'embedding'],
    reason: TURN_INPUT_REASON,
  },
  'inputs.attachments': {
    profileTypes: [...TURN_INPUT_TYPES, 'embedding'],
    reason: TURN_INPUT_REASON,
  },
  'inputs.maxFiles': {
    profileTypes: [...TURN_INPUT_TYPES, 'transcription', 'embedding'],
    reason: TURN_INPUT_REASON,
  },
  'inputs.maxBytes': {
    profileTypes: [...TURN_INPUT_TYPES, 'transcription', 'embedding'],
    reason: TURN_INPUT_REASON,
  },
  'inputs.maxTurnBytes': {
    profileTypes: [...TURN_INPUT_TYPES, 'transcription', 'embedding'],
    reason: TURN_INPUT_REASON,
  },
  'inputs.limitsByMime': {
    profileTypes: [...TURN_INPUT_TYPES, 'transcription', 'embedding'],
    reason: TURN_INPUT_REASON,
  },
  'inputs.slots': {
    profileTypes: SLOT_TYPES,
    reason: SLOT_REASON,
  },
  'inputs.context': {
    profileTypes: SLOT_TYPES,
    reason: SLOT_REASON,
  },
  'inputs.state': {
    profileTypes: ['decision'],
    reason: 'only a decision reads JSON state; a turn takes text, files, and slots',
  },
  'inputs.maxStateBytes': {
    profileTypes: ['decision'],
    reason: 'only a decision reads JSON state; a turn takes text, files, and slots',
  },
  outputs: {
    profileTypes: ['text', 'image', 'speech'],
    reason:
      'live output is the realtime session, a transcription gives back its text, and decision, embedding, and host profiles produce no turn output',
  },
  'outputs.structured': {
    profileTypes: ['text'],
    reason: 'only a text reply has a JSON shape; image and speech turns return media',
    offValue: null,
  },
  'outputs.validation': {
    profileTypes: ['text'],
    reason: 'validation checks a structured reply, which only text profiles make',
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
  'turnBehaviour.atStepLimit': {
    profileTypes: ['text'],
    reason: 'only a text turn writes an answer after its tools',
  },
  'guardrails.quota': {
    profileTypes: turnGuardrailTypes('quota'),
    reason: 'quota counts model turns, and decision, embedding, and host profiles run none',
  },
  'guardrails.detect': {
    profileTypes: turnGuardrailTypes('detect'),
    reason: 'decision and embedding calls run none of the turn guardrails',
  },
  'guardrails.blockedReply': {
    profileTypes: ['text', 'image', 'live'],
    reason:
      'only a reply can be blocked, and speech, transcription, decision, embedding, and host profiles write none',
  },
  'guardrails.network': {
    profileTypes: ['text', 'image', 'live', 'host'],
    reason: 'speech, transcription, decision, and embedding profiles call no tools',
  },
  'guardrails.taint': {
    profileTypes: ['text', 'image', 'live'],
    reason:
      'speech, transcription, decision, and embedding profiles call no tools, and a host profile runs no turn to taint',
  },
  'guardrails.disclosure': {
    profileTypes: ['decision'],
    reason: 'only a decision profile sends state to its model, and disclosure gates that state',
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
    for (const [at, value] of valuesAt(profile, profileKeysOf(path))) {
      if (scope.offValue !== undefined && value === scope.offValue) continue;
      out.push({ path: at, scope });
    }
  }
  return out;
}
