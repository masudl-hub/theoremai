/**
 * Runtime profile registry for host-owned THEOREM profiles.
 *
 * THEOREM ships profile types — not application profiles and not invented defaults.
 * Hosts must pass required fields explicitly (`type`, `models`, …).
 *
 * @module
 */

import { TheoremError } from '../../guardrails/error.ts';
import { type LexiconOverrides, validateLexiconOverrides } from '../../guardrails/lexicon.ts';
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
  isValidPair,
  isValidProfileProtocol,
  protocolsForProfileType,
} from '../schema.ts';
import { isContinueStopKind, type ProfileTurnResumptionSpec } from '../stop.ts';
import { getTool } from '../tools/registry.ts';
import { profileToolAllow, profileToolsSpec } from '../tools/resolve.ts';
import type {
  CompactionSpec,
  DecisionModelBinding,
  DecisionProfile,
  HostProfile,
  HostProfileToolsSpec,
  ImageProfile,
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
  Protocol,
  Provider,
  SpeechGuardrailsSpec,
  SpeechProfile,
  TextProfile,
} from '../types.ts';
import { profileInputs } from './catalog.ts';
import { soleModelId } from './sole-model.ts';

const profiles = new Map<string, Profile>();

/**
 * Common host-authored fields for text, image, speech, and live profiles. A host
 * profile is deliberately separate because it invokes tools without a model turn.
 */
export type ProfileDefinitionBase = {
  id: Profile['id'];
  identity: ProfileIdentity;
  models: Record<ModelId, ModelBinding>;
  defaultModel?: ModelId;
  allowModelSelect?: boolean;
  maxSteps?: number;
  key?: ProfileModelFields['key'];
  outputs?: ProfileOutputsSpec;
  guardrails?: ProfileGuardrailsSpec;
  observability?: ProfileObservabilitySpec;
  lexicon?: LexiconOverrides;
};

/** Host definition for a turn-based text profile with declared tools and input media policy. */
export type TextProfileDefinition = ProfileDefinitionBase & {
  type: 'text';
  tools: ProfileToolsSpec;
  inputs: ProfileInputsSpec;
  turnBehaviour?: ProfileTurnBehaviourSpec;
};

/** Host definition for a turn-based image profile with declared image output constraints. */
export type ImageProfileDefinition = ProfileDefinitionBase & {
  type: 'image';
  image: NonNullable<ImageProfile['image']>;
  tools: ProfileToolsSpec;
  inputs: ProfileInputsSpec;
  turnBehaviour?: MediaTurnBehaviourSpec;
};

/** Host definition for a turn-based speech profile with declared speech output constraints. */
export type SpeechProfileDefinition = Omit<ProfileDefinitionBase, 'identity' | 'guardrails'> & {
  type: 'speech';
  identity: SpeechProfile['identity'];
  guardrails?: SpeechGuardrailsSpec;
  speech: NonNullable<SpeechProfile['speech']>;
  turnBehaviour?: MediaTurnBehaviourSpec;
};

/** Host definition for a Gemini Live profile with realtime tool and session settings. */
export type LiveProfileDefinition = ProfileDefinitionBase & {
  type: 'live';
  live: NonNullable<LiveProfile['live']>;
  tools: LiveProfileToolsSpec;
  /** Inject gate only — resumption is `live.sessionResumption`. */
  turnBehaviour?: Pick<ProfileTurnBehaviourSpec, 'allowSteering'>;
};

/** Host definition for native Jev execution. */
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

/** Host-driven tool ceiling — no models, identity, inputs, outputs, turnBehaviour, key, or maxSteps. */
export type HostProfileDefinition = {
  type: 'host';
  id: Profile['id'];
  tools: HostProfileToolsSpec;
  /** Only the guards that fire on the `invokeTool` path — see {@link HostGuardrailsSpec}. */
  guardrails?: HostGuardrailsSpec;
  observability?: ProfileObservabilitySpec;
  lexicon?: LexiconOverrides;
};

/** Host-authored profile definition — discriminated on `type`. No THEOREM defaults. */
export type ProfileDefinition =
  | TextProfileDefinition
  | ImageProfileDefinition
  | SpeechProfileDefinition
  | LiveProfileDefinition
  | DecisionProfileDefinition
  | HostProfileDefinition;

function validateDecisionBinding(
  profileId: string,
  modelId: string,
  binding: DecisionModelBinding,
): void {
  if (!binding.apiId?.trim()) {
    throw new TheoremError('config', `Profile ${profileId} model '${modelId}' must set apiId`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
  if (
    binding.retry?.maxRetries !== undefined &&
    (!Number.isInteger(binding.retry.maxRetries) || binding.retry.maxRetries < 0)
  ) {
    throw new TheoremError(
      'config',
      // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      `Profile ${profileId} model '${modelId}' retry.maxRetries must be a non-negative integer`,
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
  if (!input.decision.contract?.trim()) {
    throw new TheoremError('config', `Profile ${input.id}: decision.contract must be non-empty`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

function defineDecisionProfile(input: DecisionProfileDefinition): DecisionProfile {
  validateDecisionModel(input);
  validateDecisionConfig(input);
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

/** The one owner of a model profile's default: the declared one, else the only key. */
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
  if (!binding.protocol) {
    throw new TheoremError('config', `Profile ${profileId} model '${modelId}' must set protocol`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (!binding.provider) {
    throw new TheoremError('config', `Profile ${profileId} model '${modelId}' must set provider`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (!binding.apiId) {
    throw new TheoremError('config', `Profile ${profileId} model '${modelId}' must set apiId`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (!isValidPair(binding.protocol as Protocol, binding.provider as Provider)) {
    throw new TheoremError(
      'config',
      `Profile ${profileId} model '${modelId}': protocol '${binding.protocol}' is not valid for provider '${binding.provider}'`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  assertModelEfforts(profileId, modelId, binding);
  if (binding.cache) {
    assertCacheSpec(profileId, modelId, binding);
  }
  assertInteractionsPersistence(profileId, modelId, binding);
  assertLocalServer(profileId, modelId, binding);
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

/**
 * Reject any field set on a profile type it doesn't belong to. The scope is
 * `PROFILE_FIELD_SCOPE`, the one owner of which type takes which field; it
 * covers untyped hosts the definition types can't stop.
 */
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
 * Speech has no system channel: Gemini TTS rejects developer instructions and
 * OpenAI-compatible `/audio/speech` has no field for one. The canary lives in
 * the system prompt, so registration stores it off.
 */
function speechGuardrails(input: SpeechProfileDefinition): SpeechProfile['guardrails'] {
  return { ...input.guardrails, canary: false };
}

/** Egress counts (`maxRetries`, `holdback`) are whole, non-negative numbers. */
function assertEgress(profileId: string, guardrails: ProfileGuardrailsSpec | undefined): void {
  for (const key of ['maxRetries', 'holdback'] as const) {
    const value = guardrails?.egress?.[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new TheoremError(
        'config',
        `Profile ${profileId}: guardrails.egress.${key} must be a non-negative integer`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
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

/** Define a typed profile. Required fields must be set explicitly; optional fields stay optional. */
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
  assertFieldScope(input);
  if (input.lexicon) validateLexiconOverrides(input.lexicon, `Profile ${input.id}`);
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
  for (const [modelId, binding] of Object.entries(input.models)) {
    assertModelBinding(input.id, modelId, binding);
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
  assertTypeProtocols(profile);
  return profile;
}

/** A live profile's compression numbers: whole and above 0, the target below the trigger. */
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

function assertCompactionSpec(profileId: string, modelId: ModelId, spec: CompactionSpec): void {
  const tag = `Profile ${profileId} model ${modelId} compaction`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  assertCompactionBudget(tag, spec);
  assertCompactionRetain(tag, spec);
  if (spec.meter != null && spec.meter !== 'history' && spec.meter !== 'input') {
    throw new TheoremError('config', `${tag}: meter must be 'history' or 'input'`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (!profiles.has(spec.profile)) {
    throw new TheoremError(
      'config',
      `${tag}: compaction profile '${spec.profile}' must be registered before '${profileId}'`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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

function assertCustomToolsOnly(profile: Profile): void {
  for (const id of profileToolAllow(profile)) {
    const tool = getTool(id);
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

function assertProfileToolLoader(profile: Profile): void {
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
  const tool = getTool(loaderId);
  if (tool?.type !== 'function') {
    throw new TheoremError(
      'config',
      `Profile ${profile.id} tools.t2Loader '${loaderId}' must be a registered type: 'function' tool`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

/** Every builtin id declared across a profile's model bindings. */
function* modelBuiltinIds(profile: ModelProfile): Generator<{ modelId: string; id: string }> {
  for (const [modelId, binding] of Object.entries(profile.models)) {
    for (const id of binding.builtInTools ?? []) {
      yield { modelId, id };
    }
  }
}

function assertModelBuiltInTools(profile: ModelProfile): void {
  for (const { modelId, id } of modelBuiltinIds(profile)) {
    const tool = getTool(id);
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
  const { attachments, voice, maxFiles, maxBytes, maxTurnBytes } = inputs;
  if (attachments || voice) {
    if (!(maxFiles && maxBytes && maxTurnBytes)) {
      throw new TheoremError(
        'config',
        `Profile ${profile.id} must set maxFiles, maxBytes, and maxTurnBytes`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
}

/** Register one host-owned profile in the process-local registry. */
function registerProfile(profileInput: Profile | ProfileDefinition): void {
  const profile = defineProfile(profileInput as ProfileDefinition);
  assertCustomToolsOnly(profile);
  assertProfileToolLoader(profile);
  if (profile.type === 'host') {
    // No models, ingress, media limits, or compaction to validate — the tool ceiling is the whole contract.
    profiles.set(profile.id, profile);
    return;
  }
  if (profile.type === 'decision') {
    profiles.set(profile.id, profile);
    return;
  }
  assertModelBuiltInTools(profile);
  assertMediaLimits(profile);
  for (const [modelId, binding] of Object.entries(profile.models)) {
    if (binding.compaction) {
      assertCompactionSpec(profile.id, modelId, binding.compaction);
    }
  }
  profiles.set(profile.id, profile);
}

/** Register several host-owned profiles in order. */
function registerProfiles(profilesList: Array<Profile | ProfileDefinition>): void {
  for (const p of profilesList) {
    registerProfile(p);
  }
}

/** Return whether a profile id is currently registered. */
function hasProfile(id: string): boolean {
  return profiles.has(id);
}

/**
 * A profile's observability block, or `undefined` when the id is not
 * registered — the trace of a turn on an unknown profile still records its failure.
 */
function profileObservability(id: string): ProfileObservabilitySpec | undefined {
  return profiles.get(id)?.observability;
}

/**
 * A profile's wording overrides, or `undefined` when it sets none or the id
 * is not registered (the caller's own lookup reports that).
 */
function profileLexicon(id: string): LexiconOverrides | undefined {
  return profiles.get(id)?.lexicon;
}

/** List all currently registered profiles. */
function listProfiles(): Profile[] {
  return Array.from(profiles.values());
}

/** Clear the process-local registry; intended for tests and host reloads. */
function clearProfiles(): void {
  profiles.clear();
}

/** Fetch a registered profile or throw a `TheoremError`. */
function getProfile(id: string): Profile {
  const profile = profiles.get(id);
  if (!profile) {
    throw new TheoremError('config', `Unknown profile '${id}'`);
  }
  return profile;
}

export {
  clearProfiles,
  defineProfile,
  getProfile,
  hasProfile,
  listProfiles,
  profileLexicon,
  profileObservability,
  registerProfile,
  registerProfiles,
};
