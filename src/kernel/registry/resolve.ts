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
  BuiltInArgs,
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

function isModelProfile(profile: Profile): profile is ModelProfile {
  return profile.type !== 'host' && profile.type !== 'decision' && profile.type !== 'embedding';
}

/** Returns the profile when it runs a model; throws a request error naming `door` for a host or decision profile. */
function requireModelProfile(profile: Profile, door: string): ModelProfile {
  if (isModelProfile(profile)) return profile;
  if (profile.type === 'host') {
    throw new TheoremError(
      'request',
      `Profile ${profile.id}: type 'host' never runs a model — ${door} is not supported; execute tools with invokeTool`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (profile.type === 'embedding') {
    throw new TheoremError(
      'request',
      `Profile ${profile.id}: type 'embedding' runs through runEmbedding — ${door} is not supported`, // labels-exempt: developer contract error
    );
  }
  throw new TheoremError(
    'request',
    `Profile ${profile.id}: type 'decision' runs through runDecision — ${door} is not supported`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
}

/** A request is honored only when selection is allowed; registration guarantees the default. */
function pickModel(profile: ModelProfile, requested?: string): ModelId {
  if (requested) {
    if (!profile.allowModelSelect) {
      throw new TheoremError('request', `Profile ${profile.id} does not allow model selection`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    if (!profile.models[requested]) {
      throw new TheoremError('request', `Unknown model '${requested}' for ${profile.id}`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
        `Profile ${profile.id} model '${modelId}' has no selectable efforts`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    return undefined;
  }
  const keys = Object.keys(efforts);
  if (requested) {
    if (!binding.allowEffortSelect) {
      throw new TheoremError(
        'request',
        `Profile ${profile.id} model '${modelId}' does not allow effort selection`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    const level = efforts[requested];
    if (!level) {
      throw new TheoremError(
        'request',
        `Unknown effort '${requested}' for ${profile.id} model '${modelId}'`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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

function resolveTransport(profile: ModelProfile, _binding: ModelBinding): ProviderTransport {
  return profile.type === 'live' ? 'live' : 'turn';
}

function assertTurnResumption(profile: ModelProfile, req: TurnRequest): void {
  if (!req.continueFrom) {
    return;
  }
  if (profile.type === 'live') {
    throw new TheoremError(
      'request',
      `Profile ${profile.id}: type 'live' uses live.sessionResumption, not turnBehaviour.resumption/continueFrom`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
      `Profile ${profile.id}: continueFrom requires TurnRequest.continuation when turnBehaviour.resumption.maxContinues is set`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (attempt < 1) {
    throw new TheoremError('request', `Profile ${profile.id}: continuation must be >= 1`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (attempt > max) {
    throw new TheoremError(
      'request',
      `Profile ${profile.id}: continuation ${attempt} exceeds turnBehaviour.resumption.maxContinues (${max})`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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

/**
 * The request's `builtInArgs`. Args must name a tool the chosen model lists; the protocol that
 * writes the tool parses them.
 */
function resolveBuiltInArgs(
  profile: ModelProfile,
  model: ModelId,
  binding: ModelBinding,
  args: BuiltInArgs | undefined,
): BuiltInArgs | undefined {
  if (!args) {
    return undefined;
  }
  const resolved: BuiltInArgs = {};
  for (const [id, value] of Object.entries(args)) {
    if (!binding.builtInTools?.includes(id)) {
      throw new TheoremError(
        'request',
        `Profile ${profile.id}: builtInArgs names '${id}', which model '${model}' does not list in builtInTools`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    resolved[id] = value;
  }
  return resolved;
}

/** `model` names the binding to resolve, past the profile's own selection rule. */
function resolveTurnInRegistry(
  registry: KernelRegistry,
  req: TurnRequest,
  model?: ModelId,
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
  const picked = model ?? pickModel(profile, safe.model);
  const binding = requireModelBinding(profile, picked);
  const toolSnapshot = resolveTurnTools(registry.tools, profile, safe, picked);
  const builtins = toolSnapshot.builtins;
  const structuredId = resolveStructured(profile, input.slots);
  assertOutputMode(profile, structuredId);
  assertSpeechRole(profile, safe);
  const builtInArgs = resolveBuiltInArgs(profile, picked, binding, safe.builtInArgs);
  const transport = resolveTransport(profile, binding);
  return {
    profile,
    generation: {
      model: picked,
      apiId: binding.apiId,
      transport,
      stream: resolveStreamFlag(profile),
      thinking: resolveEffort(profile, binding, picked, safe.effort),
      summaries: resolveSummaries(binding),
      maxOutputTokens: binding.maxOutputTokens,
      temperature: binding.temperature,
      builtins,
      builtInArgs,
      sessionId: safe.sessionId,
      tools: toolSnapshot,
      sessionPermissions: safe.sessionPermissions,
      execution: safe.execution,
      pageExecution: safe.pageExecution,
      history: input.history,
      maxSteps: profile.maxSteps ?? DEFAULT_MAX_STEPS,
      structured: structuredId
        ? { id: structuredId, jsonSchema: registry.schemas.get(structuredId).jsonSchema }
        : null,
      image: resolveImageFormat(profile),
      speech: resolveSpeech(profile, safe),
      live: profile.type === 'live' ? resolveLiveSpec(profile.live, profile.guardrails) : undefined,
      input: resolveInputParts(profile, safe),
      canary: plantedCanary(profile),
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
