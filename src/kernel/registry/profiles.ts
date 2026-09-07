/**
 * Runtime profile registry for host-owned THEORUM profiles.
 *
 * THEORUM ships profile types — not application profiles and not invented defaults.
 * Hosts must pass required fields explicitly (`type`, `models`, …).
 *
 * @module
 */

import { TheorumError } from '../../guardrails/error.ts';
import { assertLiveIngressConfigured } from '../engine/live-ingress.ts';
import {
  isValidPair,
  isValidProfileProtocol,
  LIVE_TOOL_LOAD_TIERS,
  protocolsForProfileType,
} from '../schema.ts';
import { getTool } from '../tools/registry.ts';
import type {
  CompactionSpec,
  ImageProfile,
  LiveProfile,
  LiveProfileToolsSpec,
  ModelBinding,
  ModelId,
  Profile,
  ProfileGuardrailsSpec,
  ProfileIdentity,
  ProfileInputsSpec,
  ProfileModelFields,
  ProfileOutputsSpec,
  ProfileToolsSpec,
  ProfileTurnResumptionSpec,
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
};

export type TextProfileDefinition = ProfileDefinitionBase & {
  type: 'text';
  tools: ProfileToolsSpec;
  inputs: ProfileInputsSpec;
  turnResumption?: ProfileTurnResumptionSpec;
};

export type ImageProfileDefinition = ProfileDefinitionBase & {
  type: 'image';
  image: NonNullable<ImageProfile['image']>;
  tools: ProfileToolsSpec;
  inputs: ProfileInputsSpec;
  turnResumption?: ProfileTurnResumptionSpec;
};

export type SpeechProfileDefinition = ProfileDefinitionBase & {
  type: 'speech';
  speech: NonNullable<SpeechProfile['speech']>;
  turnResumption?: ProfileTurnResumptionSpec;
};

export type LiveProfileDefinition = ProfileDefinitionBase & {
  type: 'live';
  live: NonNullable<LiveProfile['live']>;
  tools: LiveProfileToolsSpec;
};

/** Host-authored profile definition — discriminated on `type`. No THEORUM defaults. */
export type ProfileDefinition =
  | TextProfileDefinition
  | ImageProfileDefinition
  | SpeechProfileDefinition
  | LiveProfileDefinition;

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

function assertTypeProtocols(profile: Profile): void {
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

/** Define a typed profile. Required fields must be set explicitly; optional fields stay optional. */
function defineProfile(input: LiveProfileDefinition): LiveProfile;
function defineProfile(
  input: Exclude<ProfileDefinition, LiveProfileDefinition>,
): Exclude<Profile, LiveProfile>;
function defineProfile(input: ProfileDefinition): Profile;
function defineProfile(input: ProfileDefinition): Profile {
  assertModelsNonEmpty(input.id, input.models);
  assertDefaultModel(input.id, input);
  for (const [modelId, binding] of Object.entries(input.models)) {
    assertModelBinding(input.id, modelId, binding);
  }

  const identity: ProfileIdentity = {
    handle: input.identity.handle,
    system: input.identity.system,
    systemByRole: input.identity.systemByRole,
  };
  const guardrails = input.guardrails;
  const modelFields = profileModelFields(input);

  let profile: Profile;
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
        turnResumption: input.turnResumption,
        guardrails,
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
        turnResumption: input.turnResumption,
        guardrails,
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
        turnResumption: input.turnResumption,
        guardrails,
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
        `Profile ${profile.id} lists builtin '${id}' in tools.allow — declare it on models.*.builtInTools instead`,
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

/** Live sessions cannot promote T1/T2 — every gated tool must already be T0. */
function assertLiveToolLoadTiers(profile: LiveProfile): void {
  const liveTiers = LIVE_TOOL_LOAD_TIERS as readonly string[];
  for (const id of profile.tools.allow) {
    const tool = getTool(id);
    if (!tool) {
      continue;
    }
    if (!liveTiers.includes(tool.loadTier)) {
      throw new TheorumError(
        `Profile ${profile.id}: tools.allow '${id}' has loadTier '${tool.loadTier}' — type 'live' only supports T0 (function declarations are fixed at session setup)`,
      );
    }
  }
  for (const [modelId, binding] of Object.entries(profile.models)) {
    for (const id of binding.builtInTools ?? []) {
      const tool = getTool(id);
      if (!tool) {
        continue;
      }
      if (!liveTiers.includes(tool.loadTier)) {
        throw new TheorumError(
          `Profile ${profile.id} model '${modelId}' builtInTools '${id}' has loadTier '${tool.loadTier}' — type 'live' only supports T0`,
        );
      }
    }
  }
}

function assertProfileToolLoader(profile: Profile): void {
  if (profile.type === 'speech') {
    return;
  }
  if (profile.type === 'live') {
    assertLiveTools(profile.id, profile.tools);
    assertLiveToolLoadTiers(profile);
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

function assertModelBuiltInTools(profile: Profile): void {
  for (const [modelId, binding] of Object.entries(profile.models)) {
    for (const id of binding.builtInTools ?? []) {
      const tool = getTool(id);
      if (tool?.type !== 'builtin') {
        throw new TheorumError(
          `Profile ${profile.id} model '${modelId}' lists '${id}' in builtInTools — not a registered builtin`,
        );
      }
    }
  }
}

function assertCompactionOnlyOnText(profile: Profile): void {
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

function assertMediaLimits(profile: Profile): void {
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
