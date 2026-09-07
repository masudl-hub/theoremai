/**
 * Runtime profile registry for host-owned THEORUM profiles.
 *
 * THEORUM ships profile types — not application profiles and not invented defaults.
 * Hosts must pass required fields explicitly (`type`, `model.protocol`, `model.provider`, …).
 *
 * @module
 */

import { TheorumError } from '../../guardrails/error.ts';
import { assertLiveIngressConfigured } from '../engine/live-ingress.ts';
import { isValidPair, isValidProfileProtocol, protocolsForProfileType } from '../schema.ts';
import { getTool } from '../tools/registry.ts';
import type {
  CompactionSpec,
  ImageProfile,
  LiveProfile,
  LiveProfileModelSpec,
  LiveProfileToolsSpec,
  ModelId,
  Profile,
  ProfileGuardrailsSpec,
  ProfileIdentity,
  ProfileInputsSpec,
  ProfileModelSpec,
  ProfileOutputsSpec,
  ProfileToolsSpec,
  ProfileTurnResumptionSpec,
  Protocol,
  Provider,
  SpeechProfile,
  TextProfile,
  TurnProfileModelSpec,
} from '../types.ts';

const profiles = new Map<string, Profile>();

export type ProfileDefinitionBase<P extends ProfileModelSpec = ProfileModelSpec> = {
  id: Profile['id'];
  identity: ProfileIdentity;
  model: P;
  outputs?: ProfileOutputsSpec;
  guardrails?: ProfileGuardrailsSpec;
};

export type TextProfileDefinition = ProfileDefinitionBase<TurnProfileModelSpec> & {
  type: 'text';
  tools: ProfileToolsSpec;
  inputs: ProfileInputsSpec;
  turnResumption?: ProfileTurnResumptionSpec;
};

export type ImageProfileDefinition = ProfileDefinitionBase<TurnProfileModelSpec> & {
  type: 'image';
  image: NonNullable<ImageProfile['image']>;
  tools: ProfileToolsSpec;
  inputs: ProfileInputsSpec;
  turnResumption?: ProfileTurnResumptionSpec;
};

export type SpeechProfileDefinition = ProfileDefinitionBase<TurnProfileModelSpec> & {
  type: 'speech';
  speech: NonNullable<SpeechProfile['speech']>;
  turnResumption?: ProfileTurnResumptionSpec;
};

export type LiveProfileDefinition = {
  id: Profile['id'];
  identity: ProfileIdentity;
  model: LiveProfileModelSpec;
  type: 'live';
  live: NonNullable<LiveProfile['live']>;
  tools: LiveProfileToolsSpec;
  guardrails?: ProfileGuardrailsSpec;
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

function assertProtocolProvider(profileId: string, model: ProfileModelSpec): void {
  if (!model.protocol) {
    throw new TheorumError(`Profile ${profileId} must set model.protocol`);
  }
  if (!model.provider) {
    throw new TheorumError(`Profile ${profileId} must set model.provider`);
  }
  if (!isValidPair(model.protocol as Protocol, model.provider as Provider)) {
    throw new TheorumError(
      `Profile ${profileId}: protocol '${model.protocol}' is not valid for provider '${model.provider}'`,
    );
  }
}

function assertTypeProtocol(profile: Profile): void {
  const protocol = profile.model.protocol as Protocol;
  if (isValidProfileProtocol(profile.type, protocol)) return;
  const valid = protocolsForProfileType(profile.type).join(', ');
  throw new TheorumError(
    `Profile ${profile.id}: type '${profile.type}' cannot use protocol '${protocol}'. Supported: ${valid}`,
  );
}

/** Define a typed profile. Required fields must be set explicitly; optional fields stay optional. */
function defineProfile(input: ProfileDefinition): Profile {
  assertProtocolProvider(input.id, input.model);
  assertModelSpecs(input.id, input.model.allow, input.model.config);

  const identity: ProfileIdentity = {
    handle: input.identity.handle,
    system: input.identity.system,
    systemByRole: input.identity.systemByRole,
  };
  const guardrails = input.guardrails;

  let profile: Profile;
  switch (input.type) {
    case 'text':
      profile = {
        type: 'text',
        id: input.id,
        identity,
        model: input.model,
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
        model: input.model,
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
        model: input.model,
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
        model: input.model,
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
