import { streamPlanOf } from '../../guardrails/egress-stream.ts';
import { TheoremError } from '../../guardrails/error.ts';
import { type LexiconOverrides, validateLexiconOverrides } from '../../guardrails/lexicon.ts';
import { SENSITIVE_GROUPS } from '../../guardrails/sensitive.ts';
import type {
  DecisionGuardrailsSpec,
  HostGuardrailsSpec,
  ProfileGuardrailsSpec,
} from '../../guardrails/types.ts';
import { resolveObservabilityPolicy } from '../../observability/resolve-policy.ts';
import type { ProfileObservabilitySpec } from '../../observability/types.ts';
import { assertLiveIngressConfigured } from '../engine/live-ingress.ts';
import { outOfScopeFields } from '../profile-scope.ts';
import {
  CACHE_MODES,
  CACHE_TTLS,
  IMAGE_ATTACHMENT_ACCEPT_MIMES,
  isKeySlotName,
  isValidPair,
  isValidProfileProtocol,
  PROFILE_FIELDS,
  PROFILE_TYPES,
  type ProfileType,
  protocolsForProfileType,
  thinkingLevelsForProtocol,
} from '../schema.ts';
import { isContinueStopKind, type ProfileTurnResumptionSpec } from '../stop.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { profileToolAllow, profileToolsSpec } from '../tools/resolve.ts';
import type {
  CompactionSpec,
  DecisionModelBinding,
  DecisionProfile,
  HostProfile,
  HostProfileToolsSpec,
  ImageInputsSpec,
  ImageProfile,
  KeySlot,
  LiveContextCompressionSpec,
  LiveProfile,
  LiveProfileToolsSpec,
  MediaTurnBehaviourSpec,
  ModelBinding,
  ModelId,
  ModelProfile,
  Profile,
  ProfileIdentity,
  ProfileInputsSpec,
  ProfileModelFields,
  ProfileOutputsSpec,
  ProfileToolsSpec,
  ProfileTurnBehaviourSpec,
  SpeechGuardrailsSpec,
  SpeechProfile,
  TextProfile,
} from '../types.ts';
import { mimeAllowed, profileInputs } from './catalog.ts';
import { soleModelId } from './sole-model.ts';

/** Not shared by host profiles, which invoke tools without a model turn. */
export type ProfileDefinitionBase = {
  id: Profile['id'];
  identity: ProfileIdentity;
  models: Record<ModelId, ModelBinding>;
  defaultModel?: ModelId;
  allowModelSelect?: boolean;
  maxSteps?: number;
  key?: ProfileModelFields['key'];
  fallbackKey?: ProfileModelFields['fallbackKey'];
  outputs?: ProfileOutputsSpec;
  guardrails?: ProfileGuardrailsSpec;
  observability?: ProfileObservabilitySpec;
  lexicon?: LexiconOverrides;
};

export type TextProfileDefinition = ProfileDefinitionBase & {
  type: 'text';
  tools: ProfileToolsSpec;
  inputs: ProfileInputsSpec;
  turnBehaviour?: ProfileTurnBehaviourSpec;
};

export type ImageProfileDefinition = ProfileDefinitionBase & {
  type: 'image';
  image: NonNullable<ImageProfile['image']>;
  tools: ProfileToolsSpec;
  inputs: ImageInputsSpec;
  turnBehaviour?: MediaTurnBehaviourSpec;
};

export type SpeechProfileDefinition = Omit<ProfileDefinitionBase, 'identity' | 'guardrails'> & {
  type: 'speech';
  identity: SpeechProfile['identity'];
  guardrails?: SpeechGuardrailsSpec;
  speech: NonNullable<SpeechProfile['speech']>;
  turnBehaviour?: MediaTurnBehaviourSpec;
};

export type LiveProfileDefinition = ProfileDefinitionBase & {
  type: 'live';
  live: NonNullable<LiveProfile['live']>;
  tools: LiveProfileToolsSpec;
  /** Inject gate only — resumption is `live.sessionResumption`. */
  turnBehaviour?: Pick<ProfileTurnBehaviourSpec, 'allowSteering'>;
};

export type DecisionProfileDefinition = {
  type: 'decision';
  id: Profile['id'];
  identity: Pick<ProfileIdentity, 'handle'>;
  /** Exactly one model. */
  models: Record<ModelId, DecisionModelBinding>;
  key?: import('../types.ts').KeySlot;
  inputs: DecisionProfile['inputs'];
  decision: DecisionProfile['decision'];
  guardrails?: DecisionGuardrailsSpec;
  observability?: ProfileObservabilitySpec;
  lexicon?: LexiconOverrides;
};

export type HostProfileDefinition = {
  type: 'host';
  id: Profile['id'];
  tools: HostProfileToolsSpec;
  /** Only the guards that fire on the `invokeTool` path. */
  guardrails?: HostGuardrailsSpec;
  observability?: ProfileObservabilitySpec;
  lexicon?: LexiconOverrides;
};

export type ProfileDefinition =
  | TextProfileDefinition
  | ImageProfileDefinition
  | SpeechProfileDefinition
  | LiveProfileDefinition
  | DecisionProfileDefinition
  | HostProfileDefinition;

function assertModelRoute(
  profileId: string,
  modelId: string,
  binding: Pick<ModelBinding, 'protocol' | 'provider' | 'apiId'>,
  type?: ProfileType,
): void {
  if (!binding.protocol) {
    throw new TheoremError('config', `Profile ${profileId} model '${modelId}' must set protocol`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (!binding.provider) {
    throw new TheoremError('config', `Profile ${profileId} model '${modelId}' must set provider`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (!binding.apiId || (type === 'decision' && !binding.apiId.trim())) {
    throw new TheoremError('config', `Profile ${profileId} model '${modelId}' must set apiId`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (type === 'decision' && !isValidProfileProtocol(type, binding.protocol)) {
    throw new TheoremError(
      'config',
      // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      `Profile ${profileId} model '${modelId}': type 'decision' cannot use protocol '${binding.protocol}'. Supported: decision`,
    );
  }
  if (!isValidPair(binding.protocol, binding.provider)) {
    throw new TheoremError(
      'config',
      // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      `Profile ${profileId} model '${modelId}': protocol '${binding.protocol}' is not valid for provider '${binding.provider}'`,
    );
  }
}

function validateDecisionBinding(
  profileId: string,
  modelId: string,
  binding: DecisionModelBinding,
): void {
  assertModelRoute(profileId, modelId, binding, 'decision');
  if ('retry' in binding) {
    throw new TheoremError(
      'config',
      // lexicon-exempt: developer contract / internal diagnostic
      `Profile ${profileId} model '${modelId}': decision retry configuration is unsupported; POSTs are never retried`,
    );
  }
  if (
    binding.timeoutMs !== undefined &&
    (!Number.isFinite(binding.timeoutMs) || binding.timeoutMs <= 0)
  ) {
    throw new TheoremError(
      'config',
      `Profile ${profileId} model '${modelId}' timeoutMs must be > 0`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

function validateDecisionModel(input: DecisionProfileDefinition): void {
  const modelId = input.models ? soleModelId(input.models) : undefined;
  const binding = modelId ? input.models[modelId] : undefined;
  if (!modelId || !binding) {
    throw new TheoremError(
      'config',
      `Profile ${input.id}: type 'decision' must declare exactly one model`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  validateDecisionBinding(input.id, modelId, binding);
}

function validateDecisionConfig(input: DecisionProfileDefinition): void {
  if (input.inputs.state !== 'json') {
    throw new TheoremError('config', `Profile ${input.id}: decision inputs.state must be 'json'`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const cap = input.inputs.maxStateBytes;
  if (cap !== undefined && !(Number.isInteger(cap) && cap > 0)) {
    throw new TheoremError(
      'config',
      `Profile ${input.id}: decision inputs.maxStateBytes must be a positive integer`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (!input.decision.contract?.trim()) {
    throw new TheoremError('config', `Profile ${input.id}: decision.contract must be non-empty`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

function defineDecisionProfile(input: DecisionProfileDefinition): DecisionProfile {
  validateDecisionModel(input);
  validateDecisionConfig(input);
  assertSlotName(input.id, 'key', input.key);
  for (const [modelId, binding] of Object.entries(input.models)) {
    assertSlotName(input.id, `models.${modelId}.key`, binding.key);
    if (!binding.key && !input.key) {
      throw new TheoremError(
        'config',
        `Profile ${input.id} model '${modelId}': a decision model needs models.*.key or the profile key`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
  assertObservability(input.id, input.observability);
  return { ...input, identity: { handle: input.identity.handle } };
}

function defineHostProfile(input: HostProfileDefinition): HostProfile {
  assertHostTools(input.id, input.tools);
  assertObservability(input.id, input.observability);
  return {
    type: 'host',
    id: input.id,
    tools: { allow: input.tools.allow },
    guardrails: input.guardrails,
    observability: input.observability,
    lexicon: input.lexicon,
  } satisfies HostProfile;
}

function assertHostTools(profileId: string, tools: HostProfileToolsSpec | undefined): void {
  if (!Array.isArray(tools?.allow)) {
    throw new TheoremError('config', `Profile ${profileId}: type 'host' must set tools.allow`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

function assertModelsNonEmpty(profileId: string, models: Record<ModelId, ModelBinding>): void {
  if (Object.keys(models).length === 0) {
    throw new TheoremError('config', `Profile ${profileId} must declare at least one model`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

function resolveDefaultModel(profileId: string, input: ProfileDefinitionBase): ModelId {
  const ids = Object.keys(input.models);
  const inferred = input.defaultModel ?? soleModelId(input.models);
  if (!inferred) {
    throw new TheoremError(
      'config',
      `Profile ${profileId} must set defaultModel when more than one model is declared`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (!input.models[inferred]) {
    throw new TheoremError(
      'config',
      `Profile ${profileId} defaultModel '${inferred}' is not declared`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (input.allowModelSelect && ids.length < 2) {
    throw new TheoremError(
      'config',
      `Profile ${profileId} allowModelSelect requires at least two models`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  return inferred;
}

function assertModelBinding(profileId: string, modelId: ModelId, binding: ModelBinding): void {
  assertModelRoute(profileId, modelId, binding);
  assertModelEfforts(profileId, modelId, binding);
  if (binding.cache) {
    assertCacheSpec(profileId, modelId, binding);
  }
  assertInteractionsPersistence(profileId, modelId, binding);
  assertLocalServer(profileId, modelId, binding);
}

function assertSlotName(profileId: string, path: string, slot: KeySlot | undefined): void {
  if (slot !== undefined && !isKeySlotName(slot)) {
    throw new TheoremError(
      'config',
      `Profile ${profileId}: ${path} '${slot}' is not a key slot name; use letters, digits, '-' and '_', up to 32 characters`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

/** A model's key and fallback, each its own or the profile's. A fallback is never implied. */
function assertKeySlot(
  profileId: string,
  modelId: ModelId,
  binding: ModelBinding,
  profile: { key?: KeySlot; fallbackKey?: KeySlot },
): void {
  assertSlotName(profileId, `models.${modelId}.key`, binding.key);
  assertSlotName(profileId, `models.${modelId}.fallbackKey`, binding.fallbackKey);
  const key = binding.key ?? profile.key;
  const fallback = binding.fallbackKey ?? profile.fallbackKey;
  if (binding.provider !== 'local' && !key) {
    throw new TheoremError(
      'config',
      `Profile ${profileId} model '${modelId}': a ${binding.provider} model needs models.*.key or the profile key`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (fallback === undefined) return;
  if (fallback === key) {
    throw new TheoremError(
      'config',
      `Profile ${profileId} model '${modelId}': fallbackKey '${fallback}' is the same slot as its key`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

function assertLocalServer(profileId: string, modelId: ModelId, binding: ModelBinding): void {
  if (binding.server === undefined) {
    return;
  }
  const tag = `Profile ${profileId} model '${modelId}'`;
  if (binding.provider !== 'local') {
    throw new TheoremError('config', `${tag}: server is only valid when provider is 'local'`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (typeof binding.server !== 'string' || binding.server.trim() === '') {
    throw new TheoremError('config', `${tag}: server must be a non-empty string`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

function assertModelEfforts(profileId: string, modelId: ModelId, binding: ModelBinding): void {
  const efforts = binding.efforts;
  if (!efforts || Object.keys(efforts).length === 0) {
    if (binding.defaultEffort || binding.allowEffortSelect) {
      throw new TheoremError(
        'config',
        `Profile ${profileId} model '${modelId}': defaultEffort and allowEffortSelect require efforts`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    return;
  }
  const allowed = thinkingLevelsForProtocol(binding.protocol);
  for (const [alias, level] of Object.entries(efforts)) {
    if (!allowed.includes(level)) {
      throw new TheoremError(
        'config',
        `Profile ${profileId} model '${modelId}' effort '${alias}': '${level}' is not a thinking level ${binding.protocol} accepts (${allowed.join(', ')})`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
  const keys = Object.keys(efforts);
  const defaultAlias = binding.defaultEffort ?? (keys.length === 1 ? keys[0] : undefined);
  if (!defaultAlias) {
    throw new TheoremError(
      'config',
      `Profile ${profileId} model '${modelId}' must set defaultEffort when more than one effort is declared`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (!efforts[defaultAlias]) {
    throw new TheoremError(
      'config',
      `Profile ${profileId} model '${modelId}' defaultEffort '${defaultAlias}' is not declared`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (binding.allowEffortSelect && keys.length < 2) {
    throw new TheoremError(
      'config',
      `Profile ${profileId} model '${modelId}' allowEffortSelect requires at least two efforts`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

function assertTypeProtocols(profile: ModelProfile): void {
  for (const [modelId, binding] of Object.entries(profile.models)) {
    if (!isValidProfileProtocol(profile.type, binding.protocol)) {
      const valid = protocolsForProfileType(profile.type).join(', ');
      throw new TheoremError(
        'config',
        `Profile ${profile.id} model '${modelId}': type '${profile.type}' cannot use protocol '${binding.protocol}'. Supported: ${valid}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
}

function profileModelFields(input: ProfileDefinitionBase): ProfileModelFields {
  return {
    models: input.models,
    defaultModel: resolveDefaultModel(input.id, input),
    allowModelSelect: input.allowModelSelect,
    maxSteps: input.maxSteps,
    key: input.key,
    fallbackKey: input.fallbackKey,
  };
}

function assertContinueKindList(
  profileId: string,
  path: 'allowContinue' | 'autoContinue',
  kinds: readonly string[] | undefined,
): void {
  if (!kinds?.length) return;
  for (const kind of kinds) {
    if (!isContinueStopKind(kind)) {
      throw new TheoremError(
        'config',
        `Profile ${profileId}: turnBehaviour.resumption.${path} may only include ContinueStopKind ` + // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
          `(length | stream_incomplete | provider_error); got '${kind}'`,
      );
    }
  }
}

function assertResumption(
  profileId: string,
  resumption: ProfileTurnResumptionSpec | undefined,
): void {
  if (!resumption) return;
  assertContinueKindList(profileId, 'allowContinue', resumption.allowContinue);
  assertContinueKindList(profileId, 'autoContinue', resumption.autoContinue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `*` spans a map's entries; a path through an absent parent yields nothing. */
function valuesAt(root: Record<string, unknown>, path: readonly string[]): unknown[] {
  let level: unknown[] = [root];
  for (const key of path) {
    level = level.flatMap((value) => {
      if (!isRecord(value)) return [];
      return key === '*' ? Object.values(value) : [value[key]];
    });
  }
  return level;
}

const REQUIRED_PATHS: readonly (readonly [string, readonly ProfileType[] | undefined])[] =
  Object.entries(PROFILE_FIELDS)
    .filter(([, meta]) => meta.required === true)
    .map(([path, meta]) => [path, meta.profileTypes] as const)
    .sort(([a], [b]) => a.split('.').length - b.split('.').length);

/** A definition may come over the network (a playground draft), so its shape is checked before anything reads it. */
function assertProfileShape(input: unknown): asserts input is ProfileDefinition {
  if (!isRecord(input)) {
    throw new TheoremError('config', 'Profile definition must be an object'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const id = typeof input.id === 'string' && input.id.trim() ? input.id : undefined;
  if (!id) {
    throw new TheoremError('config', 'Profile definition must set id'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const type = PROFILE_TYPES.find((known) => known === input.type);
  if (!type) {
    throw new TheoremError(
      'config',
      `Profile ${id}: type must be one of ${PROFILE_TYPES.join(', ')}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

/** A field under an optional parent the definition leaves out is not required. */
function assertRequiredFields(input: ProfileDefinition): void {
  const { id, type } = input;
  const root = input as unknown as Record<string, unknown>;
  for (const [path, profileTypes] of REQUIRED_PATHS) {
    if (profileTypes && !profileTypes.includes(type)) continue;
    const keys = path.split('.');
    const parents = valuesAt(root, keys.slice(0, -1));
    const last = keys[keys.length - 1];
    const missing = parents.some((parent) => {
      if (!isRecord(parent)) return false;
      const value = parent[last];
      return value === undefined || value === null || value === '';
    });
    if (missing) {
      throw new TheoremError(
        'config',
        `Profile ${id}: type '${type}' must set ${path}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
}

/** Covers untyped hosts that the definition types can't stop. */
function assertFieldScope(input: ProfileDefinition): void {
  const [field] = outOfScopeFields(input);
  if (!field) return;
  const { offValue, reason } = field.scope;
  const allowed = offValue === undefined ? '' : ` (other than ${offValue})`;
  throw new TheoremError(
    'config',
    `Profile ${input.id}: type '${input.type}' must not set ${field.path}${allowed} — ${reason}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
}

function assertTurnBehaviour(profileId: string, input: ProfileDefinition): void {
  if (input.type === 'host' || input.type === 'decision') return;
  const tb = input.turnBehaviour as ProfileTurnBehaviourSpec | undefined;
  assertResumption(profileId, tb?.resumption);
}

/**
 * The canary lives in the system prompt, and speech has none: Gemini TTS rejects developer
 * instructions and OpenAI-compatible `/audio/speech` has no field for one.
 */
function speechGuardrails(input: SpeechProfileDefinition): SpeechProfile['guardrails'] {
  return { ...input.guardrails, canary: false };
}

function assertEgress(profileId: string, guardrails: ProfileGuardrailsSpec | undefined): void {
  const egress = guardrails?.egress;
  for (const key of ['maxRetries', 'holdback'] as const) {
    const value = egress?.[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new TheoremError(
        'config',
        `Profile ${profileId}: guardrails.egress.${key} must be a non-negative integer`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
  if (egress?.holdback !== undefined && streamPlanOf(egress.enforce)) {
    throw new TheoremError(
      'config',
      `Profile ${profileId}: guardrails.egress.holdback applies only to a host egress.enforce; the bundled policy holds exactly what could still become a match`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

/** A misspelt group would leave the group it meant on, silently. */
function assertRedactSensitive(profileId: string, guardrails: unknown): void {
  const selection = (guardrails as ProfileGuardrailsSpec | undefined)?.redactSensitive;
  if (selection === undefined || typeof selection === 'boolean') return;
  const groups = new Set<string>(SENSITIVE_GROUPS);
  const bad = Object.entries(selection).find(
    ([group, on]) => !groups.has(group) || typeof on !== 'boolean',
  );
  if (bad !== undefined) {
    throw new TheoremError(
      'config',
      `Profile ${profileId}: guardrails.redactSensitive.${bad[0]} is not a group (${SENSITIVE_GROUPS.join(', ')}) set to a boolean`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

function assertObservability(profileId: string, spec: ProfileObservabilitySpec | undefined): void {
  if (!spec) {
    return;
  }
  try {
    const policy = resolveObservabilityPolicy(spec);
    if (!Number.isFinite(policy.retainForDays)) {
      throw new TheoremError(
        'config',
        `Profile ${profileId}: observability.retainForDays must be a finite number`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    if (policy.rotateAfterMiB <= 0 || !Number.isFinite(policy.rotateAfterMiB)) {
      throw new TheoremError(
        'config',
        `Profile ${profileId}: observability.rotateAfterMiB must be a positive number`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  } catch (err) {
    if (err instanceof TheoremError && err.message.startsWith('Profile ')) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new TheoremError('config', `Profile ${profileId}: ${message}`);
  }
}

function defineProfile(input: TextProfileDefinition): TextProfile;
function defineProfile(input: ImageProfileDefinition): ImageProfile;
function defineProfile(input: SpeechProfileDefinition): SpeechProfile;
function defineProfile(input: LiveProfileDefinition): LiveProfile;
function defineProfile(input: DecisionProfileDefinition): DecisionProfile;
function defineProfile(input: HostProfileDefinition): HostProfile;
function defineProfile(
  input: Exclude<ProfileDefinition, LiveProfileDefinition | HostProfileDefinition>,
): Exclude<Profile, LiveProfile | HostProfile>;
function defineProfile(input: ProfileDefinition): Profile;
function defineProfile(input: ProfileDefinition): Profile {
  assertProfileShape(input);
  assertFieldScope(input);
  assertRequiredFields(input);
  if (input.lexicon) validateLexiconOverrides(input.lexicon, `Profile ${input.id}`);
  assertRedactSensitive(input.id, input.guardrails);
  if (input.type === 'host') {
    return defineHostProfile(input);
  }
  if (input.type === 'decision') {
    return defineDecisionProfile(input);
  }
  assertModelsNonEmpty(input.id, input.models);
  assertTurnBehaviour(input.id, input);
  assertEgress(input.id, input.guardrails as ProfileGuardrailsSpec | undefined);
  assertObservability(input.id, input.observability);
  assertSlotName(input.id, 'key', input.key);
  assertSlotName(input.id, 'fallbackKey', input.fallbackKey);
  for (const [modelId, binding] of Object.entries(input.models)) {
    assertModelBinding(input.id, modelId, binding);
    assertKeySlot(input.id, modelId, binding, input);
  }

  const identity: ProfileIdentity =
    input.type === 'speech'
      ? { handle: input.identity.handle }
      : {
          handle: input.identity.handle,
          system: input.identity.system,
          systemByRole: input.identity.systemByRole,
        };
  const guardrails = input.guardrails;
  const observability = input.observability;
  const lexicon = input.lexicon;
  const modelFields = profileModelFields(input);

  let profile: ModelProfile;
  switch (input.type) {
    case 'text':
      profile = {
        type: 'text',
        id: input.id,
        identity,
        ...modelFields,
        tools: input.tools,
        inputs: input.inputs,
        outputs: input.outputs,
        turnBehaviour: input.turnBehaviour,
        guardrails,
        observability,
        lexicon,
      } satisfies TextProfile;
      break;
    case 'image':
      profile = {
        type: 'image',
        id: input.id,
        identity,
        ...modelFields,
        image: input.image,
        tools: input.tools,
        inputs: input.inputs,
        outputs: input.outputs,
        turnBehaviour: input.turnBehaviour,
        guardrails,
        observability,
        lexicon,
      } satisfies ImageProfile;
      assertImageAccept(profile.id, profile.inputs.attachments?.accept);
      break;
    case 'speech':
      profile = {
        type: 'speech',
        id: input.id,
        identity,
        ...modelFields,
        speech: input.speech,
        outputs: input.outputs,
        turnBehaviour: input.turnBehaviour,
        guardrails: speechGuardrails(input),
        observability,
        lexicon,
      } satisfies SpeechProfile;
      break;
    case 'live': {
      profile = {
        type: 'live',
        id: input.id,
        identity,
        ...modelFields,
        live: input.live,
        tools: { allow: input.tools.allow },
        turnBehaviour: input.turnBehaviour,
        guardrails,
        observability,
        lexicon,
      } satisfies LiveProfile;
      assertLiveIngressConfigured(profile);
      assertLiveCompression(profile.id, profile.live.contextCompression);
      break;
    }
    default: {
      const _exhaustive: never = input;
      throw new TheoremError('config', `Unknown profile type '${String(_exhaustive)}'`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
  }
  assertStructuredSlot(profile);
  assertTypeProtocols(profile);
  return profile;
}

/** A turn can pass no value outside the slot's choices, so any other mapped key is dead. */
function assertStructuredSlot(profile: ModelProfile): void {
  if (profile.type === 'live') return;
  const structured = profile.outputs?.structured;
  if (!structured || typeof structured === 'string') return;
  const choices = profileInputs(profile)?.slots?.[structured.by];
  if (!choices) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id}: outputs.structured.by '${structured.by}' is not a slot in inputs.slots`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const unknown = Object.keys(structured.map).filter((value) => !choices.includes(value));
  if (unknown.length) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id}: outputs.structured.map maps ${unknown.join(', ')}, not a choice of slot '${structured.by}'`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

function assertImageAccept(profileId: string, accept: string[] | undefined) {
  const outside = accept?.filter((rule) => !mimeAllowed(IMAGE_ATTACHMENT_ACCEPT_MIMES, rule));
  if (!outside?.length) return;
  throw new TheoremError(
    'config',
    // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    `Profile ${profileId}: an image profile's attachments take images, video and PDF only, ` +
      `not ${outside.join(', ')}`,
  );
}

function assertLiveCompression(profileId: string, spec: LiveContextCompressionSpec | undefined) {
  if (!spec) return;
  const tag = `Profile ${profileId} live.contextCompression`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  const trigger = spec.triggerTokens;
  const target = spec.slidingWindow.targetTokens;
  assertWholeTokens(`${tag}.triggerTokens`, trigger);
  assertWholeTokens(`${tag}.slidingWindow.targetTokens`, target);
  if (trigger !== undefined && target !== undefined && target >= trigger) {
    throw new TheoremError(
      'config',
      // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      `${tag}: slidingWindow.targetTokens must be below triggerTokens`,
    );
  }
}

function assertWholeTokens(tag: string, value: number | undefined) {
  if (value === undefined || (Number.isInteger(value) && value > 0)) return;
  throw new TheoremError('config', `${tag} must be a whole number above 0`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
}

function assertCompactionSpec(
  registered: ReadonlyMap<string, Profile>,
  profileId: string,
  modelId: ModelId,
  spec: CompactionSpec,
): void {
  const tag = `Profile ${profileId} model ${modelId} compaction`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  assertCompactionBudget(tag, spec);
  assertCompactionRetain(tag, spec);
  if (spec.meter != null && spec.meter !== 'history' && spec.meter !== 'input') {
    throw new TheoremError('config', `${tag}: meter must be 'history' or 'input'`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const compactor = registered.get(spec.profile);
  if (!compactor) {
    throw new TheoremError(
      'config',
      `${tag}: compaction profile '${spec.profile}' must be registered before '${profileId}'`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (compactor.type !== 'text' || compactor.inputs?.text === false) {
    throw new TheoremError(
      'config',
      `${tag}: compaction profile '${spec.profile}' must be a text profile that takes text`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

function assertCacheSpec(profileId: string, modelId: ModelId, binding: ModelBinding): void {
  const spec = binding.cache;
  if (!spec) {
    return;
  }
  const tag = `Profile ${profileId} model '${modelId}'`;
  if (binding.provider !== 'openrouter' || binding.protocol !== 'openAi') {
    throw new TheoremError(
      'config',
      `${tag}: cache is only valid when protocol is 'openAi' and provider is 'openrouter'`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (!(CACHE_MODES as readonly string[]).includes(spec.mode)) {
    throw new TheoremError(
      'config',
      `${tag}: cache.mode must be one of ${CACHE_MODES.join(' | ')}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (spec.ttl != null && !(CACHE_TTLS as readonly string[]).includes(spec.ttl)) {
    throw new TheoremError('config', `${tag}: cache.ttl must be one of ${CACHE_TTLS.join(' | ')}`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

function assertInteractionsPersistence(
  profileId: string,
  modelId: ModelId,
  binding: ModelBinding,
): void {
  if (binding.store === undefined && binding.persistViaInteractionId === undefined) {
    return;
  }
  if (binding.protocol === 'geminiInteractions' && binding.provider === 'google') {
    return;
  }
  const which =
    binding.store !== undefined && binding.persistViaInteractionId !== undefined
      ? 'store and persistViaInteractionId' // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      : binding.store !== undefined
        ? 'store'
        : 'persistViaInteractionId';
  throw new TheoremError(
    'config',
    `Profile ${profileId} model '${modelId}': ${which} is only valid when protocol is 'geminiInteractions' and provider is 'google'`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
}

function assertCompactionBudget(tag: string, spec: CompactionSpec): void {
  if (spec.maxTokens <= 0) {
    throw new TheoremError('config', `${tag}: maxTokens must be > 0`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (spec.compactAt <= 0 || spec.compactAt >= 1) {
    throw new TheoremError('config', `${tag}: compactAt must be in (0, 1)`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

function assertCompactionRetain(tag: string, spec: CompactionSpec): void {
  if (spec.previousExchanges < 0) {
    throw new TheoremError('config', `${tag}: previousExchanges must be >= 0`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (spec.previousExchanges > 0 && spec.previousExchanges < 1) {
    if (spec.previousExchanges >= spec.compactAt) {
      throw new TheoremError(
        'config',
        `${tag}: previousExchanges as fraction (${spec.previousExchanges}) must be < compactAt (${spec.compactAt})`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
  if (spec.previousExchanges >= 1 && !Number.isInteger(spec.previousExchanges)) {
    throw new TheoremError('config', `${tag}: previousExchanges >= 1 must be an integer`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

function assertCustomToolsOnly(tools: ToolRegistry, profile: Profile): void {
  for (const id of profileToolAllow(profile)) {
    const tool = tools.get(id);
    if (tool?.type === 'builtin') {
      throw new TheoremError(
        'config',
        profile.type === 'host'
          ? `Profile ${profile.id} lists builtin '${id}' in tools.allow — type 'host' never runs a model` // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
          : `Profile ${profile.id} lists builtin '${id}' in tools.allow — declare it on models.*.builtInTools instead`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
}

function assertProfileToolLoader(tools: ToolRegistry, profile: Profile): void {
  if (profile.type === 'live' || profile.type === 'host') {
    return;
  }
  const loaderId = profileToolsSpec(profile)?.t2Loader;
  if (!loaderId) {
    return;
  }
  if (!profileToolAllow(profile).includes(loaderId)) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id} tools.t2Loader '${loaderId}' must also be listed in tools.allow`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const tool = tools.get(loaderId);
  if (tool?.type !== 'function') {
    throw new TheoremError(
      'config',
      `Profile ${profile.id} tools.t2Loader '${loaderId}' must be a registered type: 'function' tool`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

function* modelBuiltinIds(profile: ModelProfile): Generator<{ modelId: string; id: string }> {
  for (const [modelId, binding] of Object.entries(profile.models)) {
    for (const id of binding.builtInTools ?? []) {
      yield { modelId, id };
    }
  }
}

function assertModelBuiltInTools(tools: ToolRegistry, profile: ModelProfile): void {
  for (const { modelId, id } of modelBuiltinIds(profile)) {
    const tool = tools.get(id);
    if (tool?.type !== 'builtin') {
      throw new TheoremError(
        'config',
        `Profile ${profile.id} model '${modelId}' lists '${id}' in builtInTools — not a registered builtin`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
}

function assertMediaLimits(profile: ModelProfile): void {
  const inputs = profileInputs(profile);
  if (!inputs) {
    return;
  }
  const { attachments, voice, maxFiles, maxBytes, maxTurnBytes, limitsByMime } = inputs;
  const limits: Record<string, number | undefined> = { maxFiles, maxBytes, maxTurnBytes };
  if ((attachments || voice) && Object.values(limits).some((value) => value === undefined)) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id} must set maxFiles, maxBytes, and maxTurnBytes`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  for (const [mime, value] of Object.entries(limitsByMime ?? {})) {
    limits[`limitsByMime['${mime}']`] = value;
  }
  for (const [name, value] of Object.entries(limits)) {
    if (value !== undefined && !(Number.isInteger(value) && value > 0)) {
      throw new TheoremError(
        'config',
        `Profile ${profile.id}: inputs.${name} must be a positive integer`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
}

interface ProfileRegistry {
  register(profileInput: Profile | ProfileDefinition): void;
  registerMany(profilesList: Array<Profile | ProfileDefinition>): void;
  /** Throws when there is none. */
  get(id: string): Profile;
  find(id: string): Profile | undefined;
  has(id: string): boolean;
  list(): Profile[];
  clear(): void;
}

/** Profiles are checked against `tools`, so register a scope's tools before its profiles. */
function createProfileRegistry(tools: ToolRegistry): ProfileRegistry {
  const profiles = new Map<string, Profile>();
  const register = (profileInput: Profile | ProfileDefinition) => {
    const profile = defineProfile(profileInput as ProfileDefinition);
    assertCustomToolsOnly(tools, profile);
    assertProfileToolLoader(tools, profile);
    if (profile.type !== 'host' && profile.type !== 'decision') {
      assertModelBuiltInTools(tools, profile);
      assertMediaLimits(profile);
      for (const [modelId, binding] of Object.entries(profile.models)) {
        if (binding.compaction) {
          assertCompactionSpec(profiles, profile.id, modelId, binding.compaction);
        }
      }
    }
    profiles.set(profile.id, profile);
  };
  return {
    register,
    registerMany(profilesList) {
      for (const p of profilesList) {
        register(p);
      }
    },
    get(id) {
      const profile = profiles.get(id);
      if (!profile) {
        throw new TheoremError('config', `Unknown profile '${id}'`);
      }
      return profile;
    },
    find: (id) => profiles.get(id),
    has: (id) => profiles.has(id),
    list: () => [...profiles.values()],
    clear: () => profiles.clear(),
  };
}

export type { ProfileRegistry };
export { createProfileRegistry, defineProfile };
