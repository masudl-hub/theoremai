/**
 * Profile resolution for THEORUM turns.
 *
 * @module
 */

import { mintCanary } from '../../guardrails/canary.ts';
import { TheorumError } from '../../guardrails/error.ts';
import { sanitizeTurnRequest } from '../../guardrails/sanitize.ts';
import { projectTools } from '../tools/project.ts';
import { resolveTurnTools } from '../tools/resolve.ts';
import type {
  ModelId,
  ModelSpec,
  Profile,
  ProfileInputsSpec,
  ProjectedProfile,
  ProviderTransport,
  ResolvedGeneration,
  StructuredSchemaId,
  SummaryMode,
  ThinkingLevel,
  TurnRequest,
} from '../types.ts';
import { clampThinkingLevel, requireModelSpec } from './catalog.ts';
import {
  assertOutputMode,
  assertSpeechRole,
  resolveImageFormat,
  resolveInputParts,
} from './ingress.ts';
import { getProfile } from './profiles.ts';
import { providerUsesKeySlots, resolveKeySlot } from './vault.ts';

function firstSelectKey(selectMap: Record<string, ModelId>): string | undefined {
  const [key] = Object.keys(selectMap);
  return key;
}

function lookupSelectId(profile: Profile, select?: string): ModelId | undefined {
  const { select: selectMap } = profile.model;
  if (!selectMap) {
    return undefined;
  }
  let key = select;
  if (!key) {
    key = firstSelectKey(selectMap);
  }
  if (!key) {
    return undefined;
  }
  return selectMap[key];
}

function pickModel(profile: Profile, select?: string): ModelId {
  if (profile.model.select) {
    const id = lookupSelectId(profile, select);
    if (!(id && profile.model.allow.includes(id))) {
      let label = '';
      if (select) {
        label = select;
      }
      throw new TheorumError(`Unknown model select '${label}' for ${profile.id}`);
    }
    return id;
  }
  const [only] = profile.model.allow;
  if (!only) {
    throw new TheorumError(`Profile ${profile.id} has no models`);
  }
  return only;
}

function thinkingFromControl(spec: ModelSpec, thinkingOn: boolean | undefined): ThinkingLevel {
  if (!spec.thinking) {
    throw new TheorumError('model.config thinking map is required when controls include thinking');
  }
  if (thinkingOn) {
    return spec.thinking.on;
  }
  return spec.thinking.off;
}

function pinnedLevel(
  pinned: Record<string, ThinkingLevel>,
  key: string | undefined,
): ThinkingLevel | undefined {
  if (!key) {
    return undefined;
  }
  return pinned[key];
}

function thinkingFromPin(profile: Profile, select?: string): ThinkingLevel {
  const pinned = profile.model.thinking;
  if (typeof pinned === 'string') {
    return pinned;
  }
  if (!pinned) {
    throw new TheorumError(`Profile ${profile.id} must pin thinking or list it in controls`);
  }
  const fromSelect = pinnedLevel(pinned, select);
  if (fromSelect) {
    return fromSelect;
  }
  const fromFirst = pinnedLevel(pinned, firstSelectKey(profile.model.select ?? {}));
  if (fromFirst) {
    return fromFirst;
  }
  throw new TheorumError(`Profile ${profile.id} must pin thinking or list it in controls`);
}

function resolveThinking(
  profile: Profile,
  spec: ModelSpec,
  thinkingOn: boolean | undefined,
  select?: string,
): ThinkingLevel {
  const raw = profile.model.controls?.includes('thinking')
    ? thinkingFromControl(spec, thinkingOn)
    : thinkingFromPin(profile, select);
  return clampThinkingLevel(spec, raw);
}

function resolveSummaries(
  profile: Profile,
  spec: ModelSpec,
  thinkingOn: boolean | undefined,
): SummaryMode | undefined {
  if (!spec.summaries) {
    return undefined;
  }
  if (profile.model.controls?.includes('thinking')) {
    if (thinkingOn) {
      return spec.summaries.on;
    }
    return spec.summaries.off;
  }
  return spec.summaries.on;
}

function resolveStructured(
  profile: Profile,
  slots?: Record<string, string>,
): StructuredSchemaId | null {
  const structured = profile.outputs?.structured;
  if (!structured) {
    return null;
  }
  if (typeof structured === 'string') {
    return structured;
  }
  const value = slots?.[structured.by];
  if (value) {
    const mapped = structured.map[value];
    if (mapped) {
      return mapped;
    }
  }
  return structured.fallback;
}

/**
 * THEORUM prefers SSE when the host omits `outputs.streaming.mode`.
 * Explicit `'buffered'` opts out; `'sse'` (or omit) yields `stream: true`.
 */
function resolveStreamFlag(profile: Profile): boolean {
  return profile.outputs?.streaming?.mode !== 'buffered';
}

function resolveStore(spec: ModelSpec, reqStore: boolean | undefined): boolean | undefined {
  if (reqStore !== undefined) {
    return reqStore;
  }
  return spec.store;
}

function assertTurnResumption(profile: Profile, req: TurnRequest): void {
  if (!req.continueFrom) {
    return;
  }
  if (profile.type === 'live') {
    throw new TheorumError(
      `Profile ${profile.id}: type 'live' uses live.sessionResumption, not turnResumption/continueFrom`,
    );
  }
  const policy = profile.turnResumption;
  const max = policy?.maxContinues;
  if (max === undefined) {
    return;
  }
  const attempt = req.continuation;
  if (attempt === undefined) {
    throw new TheorumError(
      `Profile ${profile.id}: continueFrom requires TurnRequest.continuation when turnResumption.maxContinues is set`,
    );
  }
  if (attempt < 1) {
    throw new TheorumError(`Profile ${profile.id}: continuation must be >= 1`);
  }
  if (attempt > max) {
    throw new TheorumError(
      `Profile ${profile.id}: continuation ${attempt} exceeds turnResumption.maxContinues (${max})`,
    );
  }
}

/** Resolve a host `TurnRequest` into provider-ready generation state. */
function resolveTurn(req: TurnRequest): {
  profile: Profile;
  generation: ResolvedGeneration;
} {
  const safe = sanitizeTurnRequest(req);
  const input = safe.input ?? {};
  const profile = getProfile(safe.profile);
  assertTurnResumption(profile, safe);
  const model = pickModel(profile, safe.select);
  const spec = requireModelSpec(profile, model);
  const thinkingOn = safe.thinking === true;
  const toolSnapshot = resolveTurnTools(profile, safe, model);
  const builtins = toolSnapshot.builtins;
  const structured = resolveStructured(profile, input.slots);
  assertOutputMode(profile, structured);
  assertSpeechRole(profile);
  const pinnedKey = profile.model.key ?? spec.key;
  const keySlot = providerUsesKeySlots(profile.model.provider)
    ? resolveKeySlot(pinnedKey, spec, builtins, profile.model.provider === 'google')
    : undefined;
  const transport: ProviderTransport =
    profile.type === 'live'
      ? 'geminiLive'
      : profile.model.protocol === 'geminiInteractions' && profile.model.provider === 'google'
        ? 'interactions'
        : 'openAiCompat';
  const previousInteractionId =
    spec.persistViaInteractionId === false ? undefined : safe.previousInteractionId;
  return {
    profile,
    generation: {
      model,
      apiId: spec.apiId,
      transport,
      previousInteractionId,
      store: resolveStore(spec, safe.store),
      stream: resolveStreamFlag(profile),
      thinking: resolveThinking(profile, spec, thinkingOn, safe.select),
      summaries: resolveSummaries(profile, spec, thinkingOn),
      maxOutputTokens: spec.maxOutputTokens,
      temperature: spec.temperature,
      builtins,
      googleMapsLocation: safe.googleMapsLocation,
      tools: toolSnapshot,
      sessionPermissions: safe.sessionPermissions,
      history: input.history,
      maxSteps: profile.model.maxSteps,
      structured,
      image: resolveImageFormat(profile),
      speech: profile.type === 'speech' ? profile.speech : undefined,
      live: profile.type === 'live' ? profile.live : undefined,
      input: resolveInputParts(profile, model, safe),
      keySlot,
      canary: profile.guardrails?.canary === true ? mintCanary() : '',
      sessionResumptionHandle: safe.sessionResumptionHandle ?? input.sessionResumptionHandle,
    },
  };
}

function primaryImageSpec(profile: Profile) {
  return profile.type === 'image' ? profile.image : null;
}

function profileInputsOrNull(profile: Profile): ProfileInputsSpec | null {
  if (profile.type === 'speech') {
    return null;
  }
  return profile.inputs ?? null;
}

/** Project a profile object into a safe host/UI inspection object. */
function projectProfileObject(profile: Profile): ProjectedProfile {
  const { model, identity, outputs } = profile;
  const inputs = profileInputsOrNull(profile);
  return {
    id: profile.id,
    type: profile.type,
    handle: identity.handle,
    model,
    tools: projectTools(profile),
    inputs,
    outputs: outputs ?? null,
    image: primaryImageSpec(profile),
    speech: profile.type === 'speech' ? profile.speech : null,
    live: profile.type === 'live' ? profile.live : null,
  };
}

/** Project a registered profile into a safe host/UI inspection object. */
function projectProfile(id: Profile['id']): ProjectedProfile {
  return projectProfileObject(getProfile(id));
}

function pickSystemRole(profile: Profile, requested?: string): string {
  const { identity } = profile;
  const { handle, systemByRole } = identity;
  if (requested && systemByRole && Object.hasOwn(systemByRole, requested)) {
    return requested;
  }
  return handle;
}

export { pickModel, pickSystemRole, projectProfile, projectProfileObject, resolveTurn };
