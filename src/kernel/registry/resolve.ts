import { mintCanary } from '../../guardrails/canary.ts';
import { detects } from '../../guardrails/detectors.ts';
import { TheoremError } from '../../guardrails/error.ts';
import { resolveGuardrailPolicy } from '../../guardrails/policy.ts';
import { replyIsJudged } from '../../guardrails/progressive-yield.ts';
import { sanitizeTurnRequest } from '../../guardrails/sanitize.ts';
import { DEFAULT_MAX_STEPS } from '../profile-presence.ts';
import { profileTurnResumption } from '../stop.ts';
import { projectTools } from '../tools/project.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { resolveTurnTools } from '../tools/resolve.ts';
import type {
  ModelBinding,
  ModelId,
  ModelProfile,
  Profile,
  ProfileLiveSpec,
  ProjectedProfile,
  ProviderTransport,
  ResolvedGeneration,
  StructuredSchemaId,
  SummaryMode,
  ThinkingLevel,
  TurnRequest,
} from '../types.ts';
import { profileInputs, requireModelBinding } from './catalog.ts';
import {
  assertOutputMode,
  assertSpeechRole,
  assertTurnContext,
  assertTurnSlots,
  resolveImageFormat,
  resolveInputParts,
  resolveSpeech,
} from './ingress.ts';
import type { KernelRegistry } from './kernel-registry.ts';
import { resolveTurnSystemPrompt } from './system-prompt.ts';
import { resolveKeySlot } from './vault.ts';

function isModelProfile(profile: Profile): profile is ModelProfile {
  return profile.type !== 'host' && profile.type !== 'decision';
}

/** Returns the profile when it runs a model; throws a request error naming `door` for a host or decision profile. */
function requireModelProfile(profile: Profile, door: string): ModelProfile {
  if (isModelProfile(profile)) return profile;
  if (profile.type === 'host') {
    throw new TheoremError(
      'request',
      `Profile ${profile.id}: type 'host' never runs a model — ${door} is not supported; execute tools with invokeTool`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  throw new TheoremError(
    'request',
    `Profile ${profile.id}: type 'decision' runs through runDecision — ${door} is not supported`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
}

/** A request is honored only when selection is allowed; registration guarantees the default. */
function pickModel(profile: ModelProfile, requested?: string): ModelId {
  if (requested) {
    if (!profile.allowModelSelect) {
      throw new TheoremError('request', `Profile ${profile.id} does not allow model selection`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    if (!profile.models[requested]) {
      throw new TheoremError('request', `Unknown model '${requested}' for ${profile.id}`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    return requested;
  }
  return profile.defaultModel;
}

function resolveEffort(
  profile: ModelProfile,
  binding: ModelBinding,
  modelId: ModelId,
  requested?: string,
): ThinkingLevel | undefined {
  const efforts = binding.efforts;
  if (!efforts || Object.keys(efforts).length === 0) {
    if (requested) {
      throw new TheoremError(
        'request',
        `Profile ${profile.id} model '${modelId}' has no selectable efforts`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    return undefined;
  }
  const keys = Object.keys(efforts);
  if (requested) {
    if (!binding.allowEffortSelect) {
      throw new TheoremError(
        'request',
        `Profile ${profile.id} model '${modelId}' does not allow effort selection`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    const level = efforts[requested];
    if (!level) {
      throw new TheoremError(
        'request',
        `Unknown effort '${requested}' for ${profile.id} model '${modelId}'`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    return level;
  }
  // why: Registration requires a default whenever more than one effort is declared.
  return efforts[binding.defaultEffort ?? keys[0]];
}

function resolveSummaries(binding: ModelBinding): SummaryMode | undefined {
  if (binding.summaries === true) {
    return 'auto';
  }
  if (binding.summaries === false) {
    return 'none';
  }
  return undefined;
}

function resolveStructured(
  profile: ModelProfile,
  slots?: Record<string, string>,
): StructuredSchemaId | null {
  if (profile.type === 'live') {
    return null;
  }
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

function resolveStreamFlag(profile: ModelProfile): boolean {
  if (profile.type === 'live') {
    return true;
  }
  return profile.outputs?.streaming?.mode !== 'buffered';
}

function resolveStore(binding: ModelBinding, reqStore: boolean | undefined): boolean | undefined {
  if (reqStore !== undefined) {
    return reqStore;
  }
  return binding.store;
}

/**
 * A turn chains only on a binding that says so: an interaction id sent to one
 * that does not, or a chaining turn that switches storage off, is a request error.
 */
function assertTurnChaining(
  profile: ModelProfile,
  model: ModelId,
  chains: boolean,
  req: TurnRequest,
  store: boolean | undefined,
): void {
  if (req.previousInteractionId && !chains) {
    throw new TheoremError(
      'request',
      `Profile ${profile.id} model '${model}': previousInteractionId needs a binding with persistViaInteractionId: true`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (chains && store === false) {
    throw new TheoremError(
      'request',
      `Profile ${profile.id} model '${model}': store: false cannot apply to a binding with persistViaInteractionId: true — Google chains only from a stored interaction`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

function resolveTransport(profile: ModelProfile, binding: ModelBinding): ProviderTransport {
  if (profile.type === 'live') {
    return 'geminiLive';
  }
  if (binding.protocol === 'geminiInteractions' && binding.provider === 'google') {
    return 'interactions';
  }
  return 'openAiCompat';
}

function assertTurnResumption(profile: ModelProfile, req: TurnRequest): void {
  if (!req.continueFrom) {
    return;
  }
  if (profile.type === 'live') {
    throw new TheoremError(
      'request',
      `Profile ${profile.id}: type 'live' uses live.sessionResumption, not turnBehaviour.resumption/continueFrom`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const policy = profileTurnResumption(profile);
  const max = policy?.maxContinues;
  if (max === undefined) {
    return;
  }
  const attempt = req.continuation;
  if (attempt === undefined) {
    throw new TheoremError(
      'request',
      `Profile ${profile.id}: continueFrom requires TurnRequest.continuation when turnBehaviour.resumption.maxContinues is set`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (attempt < 1) {
    throw new TheoremError('request', `Profile ${profile.id}: continuation must be >= 1`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (attempt > max) {
    throw new TheoremError(
      'request',
      `Profile ${profile.id}: continuation ${attempt} exceeds turnBehaviour.resumption.maxContinues (${max})`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

/**
 * A guarded Live profile (a detector reading `live_reply`) always transcribes its own speech: the outbound gate can only check audio
 * through its transcript.
 */
function resolveLiveSpec(
  live: ProfileLiveSpec | undefined,
  guardrails: ModelProfile['guardrails'],
): ProfileLiveSpec | undefined {
  if (!replyIsJudged(resolveGuardrailPolicy(guardrails), ['live_reply'])) {
    return live;
  }
  return { ...live, transcription: { ...live?.transcription, output: true } };
}

/**
 * A canary for the turn while `canary_leak` reads somewhere, else none. Speech
 * has no system prompt to plant one in.
 */
function plantedCanary(profile: ModelProfile): string {
  const { detect } = resolveGuardrailPolicy(profile.guardrails);
  return profile.type !== 'speech' && detects(detect, 'canary_leak') ? mintCanary() : '';
}

function resolveTurnInRegistry(
  registry: KernelRegistry,
  req: TurnRequest,
): {
  profile: ModelProfile;
  generation: ResolvedGeneration;
} {
  const profile = requireModelProfile(registry.profiles.get(req.profile), 'resolveTurn');
  assertTurnSlots(profile, req);
  assertTurnContext(profile, req);
  const safe = sanitizeTurnRequest(req, profile);
  const input = safe.input ?? {};
  assertTurnResumption(profile, safe);
  const model = pickModel(profile, safe.model);
  const binding = requireModelBinding(profile, model);
  const toolSnapshot = resolveTurnTools(registry.tools, profile, safe, model);
  const builtins = toolSnapshot.builtins;
  const structuredId = resolveStructured(profile, input.slots);
  assertOutputMode(profile, structuredId);
  assertSpeechRole(profile, safe);
  const keys = resolveKeySlot(profile, binding);
  const transport = resolveTransport(profile, binding);
  const chains = binding.persistViaInteractionId === true;
  const store = resolveStore(binding, safe.store);
  assertTurnChaining(profile, model, chains, safe, store);
  return {
    profile,
    generation: {
      model,
      apiId: binding.apiId,
      transport,
      chains,
      previousInteractionId: safe.previousInteractionId,
      store,
      stream: resolveStreamFlag(profile),
      thinking: resolveEffort(profile, binding, model, safe.effort),
      summaries: resolveSummaries(binding),
      maxOutputTokens: binding.maxOutputTokens,
      temperature: binding.temperature,
      builtins,
      googleMapsLocation: safe.googleMapsLocation,
      cache: binding.cache,
      sessionId: safe.sessionId,
      tools: toolSnapshot,
      sessionPermissions: safe.sessionPermissions,
      history: input.history,
      maxSteps: profile.maxSteps ?? DEFAULT_MAX_STEPS,
      structured: structuredId
        ? { id: structuredId, jsonSchema: registry.schemas.get(structuredId).jsonSchema }
        : null,
      image: resolveImageFormat(profile),
      speech: resolveSpeech(profile, safe),
      live: profile.type === 'live' ? resolveLiveSpec(profile.live, profile.guardrails) : undefined,
      input: resolveInputParts(profile, safe),
      ...keys,
      canary: plantedCanary(profile),
      sessionResumptionHandle: safe.sessionResumptionHandle ?? input.sessionResumptionHandle,
      resolvedSystem: resolveTurnSystemPrompt(profile, safe),
      host: safe.host,
    },
  };
}

function primaryImageSpec(profile: ModelProfile) {
  return profile.type === 'image' ? profile.image : null;
}

/** Projects a profile into the plain object a host reads: its id, type, handle, models, inputs, outputs and the tools it can use. Throws for a host or decision profile. */
function projectProfileObject(tools: ToolRegistry, input: Profile): ProjectedProfile {
  const profile = requireModelProfile(input, 'projectProfile');
  const { identity } = profile;
  const inputs = profileInputs(profile) ?? null;
  const outputs = profile.type === 'live' ? null : (profile.outputs ?? null);
  return {
    id: profile.id,
    type: profile.type,
    handle: identity.handle,
    models: profile.models,
    defaultModel: profile.defaultModel,
    allowModelSelect: profile.allowModelSelect,
    maxSteps: profile.maxSteps,
    key: profile.key,
    tools: projectTools(tools, profile),
    inputs,
    outputs,
    image: primaryImageSpec(profile),
    speech: profile.type === 'speech' ? profile.speech : null,
    live: profile.type === 'live' ? profile.live : null,
  };
}

function projectProfileInRegistry(registry: KernelRegistry, id: Profile['id']): ProjectedProfile {
  return projectProfileObject(registry.tools, registry.profiles.get(id));
}

export {
  isModelProfile,
  pickModel,
  projectProfileInRegistry,
  projectProfileObject,
  requireModelProfile,
  resolveTurnInRegistry,
};
