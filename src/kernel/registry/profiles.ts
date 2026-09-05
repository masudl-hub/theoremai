/**
 * Runtime profile registry for host-owned THEORUM profiles.
 *
 * THEORUM ships profile types — not application profiles and not invented defaults.
 * Hosts must pass required fields explicitly (`type`, `model.protocol`, `model.provider`, …).
 *
 * @module
 */

import { TheorumError } from '../../guardrails/error.ts';
import { getTool } from '../tools/registry.ts';
import type {
  CompactionSpec,
  ImageProfile,
  LiveProfile,
  ModelId,
  Profile,
  ProfileGuardrailsSpec,
  ProfileIdentity,
  ProfileInputsSpec,
  ProfileModelSpec,
  ProfileOutputsSpec,
  ProfileToolsSpec,
  ProfileTurnResumptionSpec,
  SpeechProfile,
  TextProfile,
} from '../types.ts';

const profiles = new Map<string, Profile>();

type ModelAuthored = ProfileModelSpec;

/** Shared authoring fields before type discrimination. */
export type ProfileDefinitionBase = {
  id: Profile['id'];
  identity: ProfileIdentity;
  model: ModelAuthored;
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
  tools: ProfileToolsSpec;
  inputs?: ProfileInputsSpec;
};

/** Host-authored profile definition — discriminated on `type`. No THEORUM defaults. */
export type ProfileDefinition =
  | TextProfileDefinition
  | ImageProfileDefinition
  | SpeechProfileDefinition
  | LiveProfileDefinition;

function assertModelSpecs(
  profileId: string,
  allow: ModelId[],
  config: Profile['model']['config'],
): void {
  for (const id of allow) {
    if (!config[id]) {
      throw new TheorumError(`Profile ${profileId} allowlists '${id}' without a model spec`);
    }
  }
}

function assertProtocolProvider(profileId: string, model: ModelAuthored): void {
  if (!model.protocol) {
    throw new TheorumError(`Profile ${profileId} must set model.protocol`);
  }
  if (!model.provider) {
    throw new TheorumError(`Profile ${profileId} must set model.provider`);
  }
}

function assertTypeProtocol(profile: Profile): void {
  if (profile.type === 'live' && profile.model.protocol !== 'geminiLive') {
    throw new TheorumError(
      `Profile ${profile.id}: type 'live' requires model.protocol 'geminiLive'`,
    );
  }
  if (profile.type !== 'live' && profile.model.protocol === 'geminiLive') {
    throw new TheorumError(
      `Profile ${profile.id}: model.protocol 'geminiLive' requires type 'live'`,
    );
  }
}

/** Define a typed profile. Omitted optional fields stay omitted — no invented defaults. */
function defineProfile(input: ProfileDefinition): Profile {
  assertProtocolProvider(input.id, input.model);
  assertModelSpecs(input.id, input.model.allow, input.model.config);

  const identity: ProfileIdentity = {
    handle: input.identity.handle,
    system: input.identity.system,
    systemByRole: input.identity.systemByRole,
  };
  const model: ProfileModelSpec = {
    protocol: input.model.protocol,
    provider: input.model.provider,
    allow: input.model.allow,
    config: input.model.config,
    thinking: input.model.thinking,
    controls: input.model.controls,
    maxSteps: input.model.maxSteps,
    key: input.model.key,
    select: input.model.select,
  };
  const outputs = input.outputs;
  const guardrails = input.guardrails;

  let profile: Profile;
  switch (input.type) {
    case 'text':
      profile = {
        type: 'text',
        id: input.id,
        identity,
        model,
        tools: input.tools,
        inputs: input.inputs,
        outputs,
        turnResumption: input.turnResumption,
        guardrails,
      } satisfies TextProfile;
      break;
    case 'image':
      profile = {
        type: 'image',
        id: input.id,
        identity,
        model,
        image: input.image,
        tools: input.tools,
        inputs: input.inputs,
        outputs,
        turnResumption: input.turnResumption,
        guardrails,
      } satisfies ImageProfile;
      break;
    case 'speech':
      profile = {
        type: 'speech',
        id: input.id,
        identity,
        model,
        speech: input.speech,
        outputs,
        turnResumption: input.turnResumption,
        guardrails,
      } satisfies SpeechProfile;
      break;
    case 'live':
      profile = {
        type: 'live',
        id: input.id,
        identity,
        model,
        live: input.live,
        tools: input.tools,
        inputs: input.inputs,
        outputs,
        guardrails,
      } satisfies LiveProfile;
      break;
    default: {
      const _exhaustive: never = input;
      throw new TheorumError(`Unknown profile type '${String(_exhaustive)}'`);
    }
  }
  assertTypeProtocol(profile);
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
        `Profile ${profile.id} lists builtin '${id}' in tools.allow — declare it on model.config.*.builtInTools instead`,
      );
    }
  }
}

function assertProfileToolLoader(profile: Profile): void {
  if (profile.type === 'speech') {
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
  for (const [modelId, spec] of Object.entries(profile.model.config)) {
    for (const id of spec.builtInTools ?? []) {
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
  for (const [modelId, spec] of Object.entries(profile.model.config)) {
    if (spec.compaction) {
      throw new TheorumError(
        `Profile ${profile.id} model '${modelId}': compaction is only valid on type 'text'`,
      );
    }
  }
}

function assertMediaLimits(profile: Profile): void {
  if (profile.type === 'speech') {
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
  assertModelSpecs(profile.id, profile.model.allow, profile.model.config);
  assertCustomToolsOnly(profile);
  assertProfileToolLoader(profile);
  assertModelBuiltInTools(profile);
  assertCompactionOnlyOnText(profile);
  assertMediaLimits(profile);
  for (const [modelId, spec] of Object.entries(profile.model.config)) {
    if (spec.compaction) {
      assertCompactionSpec(profile.id, modelId, spec.compaction);
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
