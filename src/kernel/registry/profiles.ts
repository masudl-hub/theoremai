/**
 * Runtime profile registry for host-owned THEORUM profiles.
 *
 * THEORUM ships profile types — not application profiles and not invented defaults.
 * Hosts must pass required fields explicitly (`type`, `models`, …).
 *
 * @module
 */

import { TheorumError } from '../../guardrails/error.ts';
import {
  HOST_GUARDRAIL_FIELDS,
  type HostGuardrailsSpec,
  type ProfileGuardrailsSpec,
} from '../../guardrails/types.ts';
import { resolveObservabilityPolicy } from '../../observability/resolve-policy.ts';
import type { ProfileObservabilitySpec } from '../../observability/types.ts';
import { assertLiveIngressConfigured } from '../engine/live-ingress.ts';
import {
  CACHE_MODES,
  CACHE_TTLS,
  isValidPair,
  isValidProfileProtocol,
  protocolsForProfileType,
} from '../schema.ts';
import { isContinueStopKind, type ProfileTurnResumptionSpec } from '../stop.ts';
import { getTool } from '../tools/registry.ts';
import type {
  CompactionSpec,
  HostProfile,
  HostProfileToolsSpec,
  ImageProfile,
  LiveProfile,
  LiveProfileToolsSpec,
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
  SpeechProfile,
  TextProfile,
} from '../types.ts';

const profiles = new Map<string, Profile>();

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
  inputs: ProfileInputsSpec;
  turnBehaviour?: ProfileTurnBehaviourSpec;
};

export type SpeechProfileDefinition = ProfileDefinitionBase & {
  type: 'speech';
  speech: NonNullable<SpeechProfile['speech']>;
  turnBehaviour?: ProfileTurnBehaviourSpec;
};

export type LiveProfileDefinition = ProfileDefinitionBase & {
  type: 'live';
  live: NonNullable<LiveProfile['live']>;
  tools: LiveProfileToolsSpec;
};

/** Host-driven tool ceiling — no models, identity, inputs, outputs, turnBehaviour, key, or maxSteps. */
export type HostProfileDefinition = {
  type: 'host';
  id: Profile['id'];
  tools: HostProfileToolsSpec;
  /** Only the guards that fire on the `invokeTool` path — see {@link HostGuardrailsSpec}. */
  guardrails?: HostGuardrailsSpec;
  observability?: ProfileObservabilitySpec;
};

/** Host-authored profile definition — discriminated on `type`. No THEORUM defaults. */
export type ProfileDefinition =
  | TextProfileDefinition
  | ImageProfileDefinition
  | SpeechProfileDefinition
  | LiveProfileDefinition
  | HostProfileDefinition;

/** Fields a `host` profile must not carry — rejected when supplied. */
const HOST_ABSENT_FIELDS = [
  'models',
  'defaultModel',
  'allowModelSelect',
  'identity',
  'inputs',
  'outputs',
  'turnBehaviour',
  'key',
  'maxSteps',
] as const;

/**
 * Guardrails that only a model turn can run, so a host profile must not declare
 * them: `egress` gates user-visible model text in the turn runner, `canary` is
 * minted into a system prompt, and `quota` counts turns. None is reachable from
 * `invokeTool`, so accepting them would register config that guards nothing.
 */
const HOST_ABSENT_GUARDRAILS = ['quota', 'canary', 'egress'] as const satisfies readonly Exclude<
  keyof ProfileGuardrailsSpec,
  keyof HostGuardrailsSpec
>[];

const HOST_GUARDRAIL_REASON: Record<(typeof HOST_ABSENT_GUARDRAILS)[number], string> = {
  quota: 'quota counts model turns',
  canary: 'canary is minted into a system prompt',
  egress: 'egress gates user-visible model text in the turn runner',
};

function assertHostGuardrails(profileId: string, guardrails: HostGuardrailsSpec | undefined): void {
  if (!guardrails) return;
  const extra = guardrails as ProfileGuardrailsSpec;
  for (const key of HOST_ABSENT_GUARDRAILS) {
    if (extra[key] !== undefined) {
      throw new TheorumError(
        `Profile ${profileId}: type 'host' must not set guardrails.${key} — a host profile runs no model and ${HOST_GUARDRAIL_REASON[key]}. Host profiles accept ${HOST_GUARDRAIL_FIELDS.join(', ')}.`,
      );
    }
  }
}

function defineHostProfile(input: HostProfileDefinition): HostProfile {
  const extra = input as HostProfileDefinition & Record<string, unknown>;
  for (const key of HOST_ABSENT_FIELDS) {
    if (extra[key] !== undefined) {
      throw new TheorumError(`Profile ${input.id}: type 'host' must not set ${key}`);
    }
  }
  assertHostGuardrails(input.id, input.guardrails);
  assertHostTools(input.id, input.tools);
  assertObservability(input.id, input.observability);
  return {
    type: 'host',
    id: input.id,
    tools: { allow: input.tools.allow },
    guardrails: input.guardrails,
    observability: input.observability,
  } satisfies HostProfile;
}

function assertHostTools(profileId: string, tools: HostProfileToolsSpec | undefined): void {
  if (!Array.isArray(tools?.allow)) {
    throw new TheorumError(`Profile ${profileId}: type 'host' must set tools.allow`);
  }
  const extra = tools as ProfileToolsSpec;
  if (extra.t1Policy !== undefined || extra.t2Loader !== undefined) {
    throw new TheorumError(
      `Profile ${profileId}: tools.t1Policy / tools.t2Loader are not supported on type 'host' — every allowed tool is executable`,
    );
  }
}

function soleModelId(models: Record<ModelId, ModelBinding>): ModelId | undefined {
  const ids = Object.keys(models);
  return ids.length === 1 ? ids[0] : undefined;
}

function assertModelsNonEmpty(profileId: string, models: Record<ModelId, ModelBinding>): void {
  if (Object.keys(models).length === 0) {
    throw new TheorumError(`Profile ${profileId} must declare at least one model`);
  }
}

function assertDefaultModel(profileId: string, input: ProfileDefinitionBase): void {
  const ids = Object.keys(input.models);
  const inferred = input.defaultModel ?? soleModelId(input.models);
  if (!inferred) {
    throw new TheorumError(
      `Profile ${profileId} must set defaultModel when more than one model is declared`,
    );
  }
  if (!input.models[inferred]) {
    throw new TheorumError(`Profile ${profileId} defaultModel '${inferred}' is not declared`);
  }
  if (input.allowModelSelect && ids.length < 2) {
    throw new TheorumError(`Profile ${profileId} allowModelSelect requires at least two models`);
  }
}

function assertModelBinding(profileId: string, modelId: ModelId, binding: ModelBinding): void {
  if (!binding.protocol) {
    throw new TheorumError(`Profile ${profileId} model '${modelId}' must set protocol`);
  }
  if (!binding.provider) {
    throw new TheorumError(`Profile ${profileId} model '${modelId}' must set provider`);
  }
  if (!binding.apiId) {
    throw new TheorumError(`Profile ${profileId} model '${modelId}' must set apiId`);
  }
  if (!isValidPair(binding.protocol as Protocol, binding.provider as Provider)) {
    throw new TheorumError(
      `Profile ${profileId} model '${modelId}': protocol '${binding.protocol}' is not valid for provider '${binding.provider}'`,
    );
  }
  assertModelEfforts(profileId, modelId, binding);
  if (binding.cache) {
    assertCacheSpec(profileId, modelId, binding);
  }
  assertInteractionsPersistence(profileId, modelId, binding);
}

function assertModelEfforts(profileId: string, modelId: ModelId, binding: ModelBinding): void {
  const efforts = binding.efforts;
  if (!efforts || Object.keys(efforts).length === 0) {
    if (binding.defaultEffort || binding.allowEffortSelect) {
      throw new TheorumError(
        `Profile ${profileId} model '${modelId}': defaultEffort and allowEffortSelect require efforts`,
      );
    }
    return;
  }
  const keys = Object.keys(efforts);
  const defaultAlias = binding.defaultEffort ?? (keys.length === 1 ? keys[0] : undefined);
  if (!defaultAlias) {
    throw new TheorumError(
      `Profile ${profileId} model '${modelId}' must set defaultEffort when more than one effort is declared`,
    );
  }
  if (!efforts[defaultAlias]) {
    throw new TheorumError(
      `Profile ${profileId} model '${modelId}' defaultEffort '${defaultAlias}' is not declared`,
    );
  }
  if (binding.allowEffortSelect && keys.length < 2) {
    throw new TheorumError(
      `Profile ${profileId} model '${modelId}' allowEffortSelect requires at least two efforts`,
    );
  }
}

function assertTypeProtocols(profile: ModelProfile): void {
  for (const [modelId, binding] of Object.entries(profile.models)) {
    if (!isValidProfileProtocol(profile.type, binding.protocol)) {
      const valid = protocolsForProfileType(profile.type).join(', ');
      throw new TheorumError(
        `Profile ${profile.id} model '${modelId}': type '${profile.type}' cannot use protocol '${binding.protocol}'. Supported: ${valid}`,
      );
    }
  }
}

function profileModelFields(input: ProfileDefinitionBase): ProfileModelFields {
  return {
    models: input.models,
    defaultModel: input.defaultModel ?? soleModelId(input.models),
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
      throw new TheorumError(
        `Profile ${profileId}: turnBehaviour.resumption.${path} may only include ContinueStopKind ` +
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

function assertTurnBehaviour(profileId: string, input: ProfileDefinition): void {
  if (input.type === 'live' || input.type === 'host') return;
  if (input.type !== 'text' && input.turnBehaviour?.allowSteering !== undefined) {
    throw new TheorumError(
      `Profile ${profileId}: turnBehaviour.allowSteering is only valid on type 'text'`,
    );
  }
  assertResumption(profileId, input.turnBehaviour?.resumption);
}

function assertObservability(profileId: string, spec: ProfileObservabilitySpec | undefined): void {
  if (!spec) {
    return;
  }
  try {
    const policy = resolveObservabilityPolicy(spec);
    if (policy.retainForDays <= 0 || !Number.isFinite(policy.retainForDays)) {
      throw new TheorumError(
        `Profile ${profileId}: observability.retainForDays must be a positive number`,
      );
    }
    if (policy.rotateAfterMiB <= 0 || !Number.isFinite(policy.rotateAfterMiB)) {
      throw new TheorumError(
        `Profile ${profileId}: observability.rotateAfterMiB must be a positive number`,
      );
    }
  } catch (err) {
    if (err instanceof TheorumError && err.message.startsWith('Profile ')) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new TheorumError(`Profile ${profileId}: ${message}`);
  }
}

/** Define a typed profile. Required fields must be set explicitly; optional fields stay optional. */
function defineProfile(input: LiveProfileDefinition): LiveProfile;
function defineProfile(input: HostProfileDefinition): HostProfile;
function defineProfile(
  input: Exclude<ProfileDefinition, LiveProfileDefinition | HostProfileDefinition>,
): Exclude<Profile, LiveProfile | HostProfile>;
function defineProfile(input: ProfileDefinition): Profile;
function defineProfile(input: ProfileDefinition): Profile {
  if (input.type === 'host') {
    return defineHostProfile(input);
  }
  assertModelsNonEmpty(input.id, input.models);
  assertDefaultModel(input.id, input);
  assertTurnBehaviour(input.id, input);
  assertObservability(input.id, input.observability);
  for (const [modelId, binding] of Object.entries(input.models)) {
    assertModelBinding(input.id, modelId, binding);
  }

  const identity: ProfileIdentity = {
    handle: input.identity.handle,
    system: input.identity.system,
    systemByRole: input.identity.systemByRole,
  };
  const guardrails = input.guardrails;
  const observability = input.observability;
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
        guardrails,
        observability,
      } satisfies SpeechProfile;
      break;
    case 'live': {
      const liveInput = input as LiveProfileDefinition & {
        inputs?: unknown;
        outputs?: unknown;
      };
      if (liveInput.inputs !== undefined) {
        throw new TheorumError(`Profile ${input.id}: type 'live' must not set inputs`);
      }
      if (liveInput.outputs !== undefined) {
        throw new TheorumError(`Profile ${input.id}: type 'live' must not set outputs`);
      }
      profile = {
        type: 'live',
        id: input.id,
        identity,
        ...modelFields,
        live: input.live,
        tools: assertLiveTools(input.id, input.tools),
        guardrails,
        observability,
      } satisfies LiveProfile;
      assertLiveIngressConfigured(profile);
      break;
    }
    default: {
      const _exhaustive: never = input;
      throw new TheorumError(`Unknown profile type '${String(_exhaustive)}'`);
    }
  }
  assertTypeProtocols(profile);
  return profile;
}

function assertCompactionSpec(profileId: string, modelId: ModelId, spec: CompactionSpec): void {
  const tag = `Profile ${profileId} model ${modelId} compaction`;
  assertCompactionBudget(tag, spec);
  assertCompactionRetain(tag, spec);
  if (spec.meter != null && spec.meter !== 'history' && spec.meter !== 'input') {
    throw new TheorumError(`${tag}: meter must be 'history' or 'input'`);
  }
  if (!profiles.has(spec.profile)) {
    throw new TheorumError(
      `${tag}: compaction profile '${spec.profile}' must be registered before '${profileId}'`,
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
    throw new TheorumError(
      `${tag}: cache is only valid when protocol is 'openAi' and provider is 'openrouter'`,
    );
  }
  if (!(CACHE_MODES as readonly string[]).includes(spec.mode)) {
    throw new TheorumError(`${tag}: cache.mode must be one of ${CACHE_MODES.join(' | ')}`);
  }
  if (spec.ttl != null && !(CACHE_TTLS as readonly string[]).includes(spec.ttl)) {
    throw new TheorumError(`${tag}: cache.ttl must be one of ${CACHE_TTLS.join(' | ')}`);
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
      ? 'store and persistViaInteractionId'
      : binding.store !== undefined
        ? 'store'
        : 'persistViaInteractionId';
  throw new TheorumError(
    `Profile ${profileId} model '${modelId}': ${which} is only valid when protocol is 'geminiInteractions' and provider is 'google'`,
  );
}

function assertCompactionBudget(tag: string, spec: CompactionSpec): void {
  if (spec.maxTokens <= 0) {
    throw new TheorumError(`${tag}: maxTokens must be > 0`);
  }
  if (spec.compactAt <= 0 || spec.compactAt >= 1) {
    throw new TheorumError(`${tag}: compactAt must be in (0, 1)`);
  }
}

function assertCompactionRetain(tag: string, spec: CompactionSpec): void {
  if (spec.previousExchanges < 0) {
    throw new TheorumError(`${tag}: previousExchanges must be >= 0`);
  }
  if (spec.previousExchanges > 0 && spec.previousExchanges < 1) {
    if (spec.previousExchanges >= spec.compactAt) {
      throw new TheorumError(
        `${tag}: previousExchanges as fraction (${spec.previousExchanges}) must be < compactAt (${spec.compactAt})`,
      );
    }
  }
  if (spec.previousExchanges >= 1 && !Number.isInteger(spec.previousExchanges)) {
    throw new TheorumError(`${tag}: previousExchanges >= 1 must be an integer`);
  }
}

function profileToolsAllow(profile: Profile): string[] {
  if (profile.type === 'speech') {
    return [];
  }
  return profile.tools.allow;
}

function assertCustomToolsOnly(profile: Profile): void {
  for (const id of profileToolsAllow(profile)) {
    const tool = getTool(id);
    if (tool?.type === 'builtin') {
      throw new TheorumError(
        profile.type === 'host'
          ? `Profile ${profile.id} lists builtin '${id}' in tools.allow — type 'host' never runs a model`
          : `Profile ${profile.id} lists builtin '${id}' in tools.allow — declare it on models.*.builtInTools instead`,
      );
    }
  }
}

function assertLiveTools(profileId: string, tools: LiveProfileToolsSpec): LiveProfileToolsSpec {
  const extra = tools as ProfileToolsSpec;
  if (extra.t1Policy !== undefined) {
    throw new TheorumError(
      `Profile ${profileId}: tools.t1Policy is not supported on type 'live' — wire T0 tools in tools.allow for session setup`,
    );
  }
  if (extra.t2Loader !== undefined) {
    throw new TheorumError(
      `Profile ${profileId}: tools.t2Loader is not supported on type 'live' — Gemini Live function declarations are fixed at session setup`,
    );
  }
  return { allow: tools.allow };
}

function assertProfileToolLoader(profile: Profile): void {
  if (profile.type === 'speech') {
    return;
  }
  if (profile.type === 'live') {
    assertLiveTools(profile.id, profile.tools);
    return;
  }
  if (profile.type === 'host') {
    assertHostTools(profile.id, profile.tools);
    return;
  }
  const loaderId = profile.tools.t2Loader;
  if (!loaderId) {
    return;
  }
  if (!profile.tools.allow.includes(loaderId)) {
    throw new TheorumError(
      `Profile ${profile.id} tools.t2Loader '${loaderId}' must also be listed in tools.allow`,
    );
  }
  const tool = getTool(loaderId);
  if (tool?.type !== 'function') {
    throw new TheorumError(
      `Profile ${profile.id} tools.t2Loader '${loaderId}' must be a registered type: 'function' tool`,
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
      throw new TheorumError(
        `Profile ${profile.id} model '${modelId}' lists '${id}' in builtInTools — not a registered builtin`,
      );
    }
  }
}

function assertCompactionOnlyOnText(profile: ModelProfile): void {
  if (profile.type === 'text') {
    return;
  }
  for (const [modelId, binding] of Object.entries(profile.models)) {
    if (binding.compaction) {
      throw new TheorumError(
        `Profile ${profile.id} model '${modelId}': compaction is only valid on type 'text'`,
      );
    }
  }
}

function assertMediaLimits(profile: ModelProfile): void {
  if (profile.type === 'speech' || profile.type === 'live') {
    return;
  }
  const inputs = profile.inputs;
  if (!inputs) {
    return;
  }
  const { attachments, voice, maxFiles, maxBytes, maxTurnBytes } = inputs;
  if (attachments || voice) {
    if (!(maxFiles && maxBytes && maxTurnBytes)) {
      throw new TheorumError(`Profile ${profile.id} must set maxFiles, maxBytes, and maxTurnBytes`);
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
  assertModelBuiltInTools(profile);
  assertCompactionOnlyOnText(profile);
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

/** List all currently registered profiles. */
function listProfiles(): Profile[] {
  return Array.from(profiles.values());
}

/** Clear the process-local registry; intended for tests and host reloads. */
function clearProfiles(): void {
  profiles.clear();
}

/** Fetch a registered profile or throw a `TheorumError`. */
function getProfile(id: string): Profile {
  const profile = profiles.get(id);
  if (!profile) {
    throw new TheorumError(`Unknown profile '${id}'`);
  }
  return profile;
}

export {
  clearProfiles,
  defineProfile,
  getProfile,
  hasProfile,
  listProfiles,
  registerProfile,
  registerProfiles,
};
