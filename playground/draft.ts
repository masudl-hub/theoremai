/**
 * Every section is always present so switching profile type keeps what the author typed.
 * "Provider default" numbers are `null` and booleans hold the value the kernel would resolve,
 * so compile emits a field only when it differs.
 */

import { type LexiconKey, liveIngressChannelDefault, profileAllowsInject, resolveGuardrailPolicy } from '../mod.ts';
import { resolveObservabilityPolicy } from '../src/observability/mod.ts';
import { mimeAllowed } from '../src/kernel/registry/catalog.ts';
import { profileTypesForField } from '../src/kernel/profile-scope.ts';
import { CONTINUE_INSTRUCTION_TYPES } from '../src/kernel/stop.ts';
import {
  type ContinueStopKind,
  type EgressOnBlock,
  IMAGE_ATTACHMENT_ACCEPT_MIMES,
  isValidProfileProtocol,
  type LiveActivityHandling,
  type LiveEndSensitivity,
  type LiveStartSensitivity,
  OVERFLOW_KEY_SLOTS,
  type OverflowKeySlot,
  PROFILE_GRAPH,
  PROFILE_TYPES,
  type ProfileGraphFacetId,
  type ProfileType,
  type Protocol,
  type Provider,
  type SpeechAudioFormat,
  type StreamMode,
  type ThinkingLevel,
  TOOL_ACCESS,
  TOOL_LOAD_TIERS,
  TOOL_PERMISSION,
} from '../src/kernel/schema.ts';
import {
  defaultBindingForProfileType,
  isGoogleTransport,
  PLAYGROUND_TRACE_DESTINATION,
  servesOtherProfileType,
} from './policy.ts';
import { DEFAULT_TOOL_INPUT_SCHEMA, DEFAULT_TOOL_OUTPUT_SCHEMA } from './tool-schema.ts';
import type { PlaygroundToolSpecSeed } from './types.ts';

/** `host` runs no model and `decision` holds no turn, so neither is authored here. */
export type PlaygroundProfileType = Exclude<ProfileType, 'host' | 'decision'>;

export const PLAYGROUND_PROFILE_TYPES: readonly PlaygroundProfileType[] = PROFILE_TYPES.filter(
  (type): type is PlaygroundProfileType => type !== 'host' && type !== 'decision',
);

export interface IdentityDraft {
  agentId: string;
  profileType: PlaygroundProfileType | '';
  handle: string;
  /** Unused on speech, which has no system channel. */
  system: string;
}

export interface ModelsDraft {
  defaultModel: string;
  allowModelSelect: boolean;
  /** `null` omits it (unbounded). */
  maxSteps: number | null;
  key: OverflowKeySlot | '';
}

export interface EffortDraft {
  alias: string;
  level: ThinkingLevel;
}

export interface ModelBindingDraft {
  /** Stable draft key; the model id is editable, so it cannot be the key. */
  key: string;
  modelId: string;
  protocol: Protocol;
  provider: Provider;
  apiId: string;
  efforts: EffortDraft[];
  defaultEffort: string;
  allowEffortSelect: boolean;
  /** Thought summaries: on, off, or `null` to leave it to the provider. */
  summaries: boolean | null;
  maxOutputTokens: number | null;
  temperature: number | null;
  builtInTools: string[];
}

export interface ToolsDraft {
  /** Function tool that promotes T2 tools; empty omits it. */
  t2Loader: string;
}

/** One custom tool: compiles to `registerTool` plus a `tools.allow` entry. */
export interface ToolSpecDraft extends PlaygroundToolSpecSeed {
  key: string;
}

export interface InputsDraft {
  text: boolean;
  attachmentsAccept: string[];
  voiceAccept: string[];
  maxFiles: number | null;
  maxBytes: number | null;
  maxTurnBytes: number | null;
}

export interface OutputsDraft {
  mode: 'text' | 'structured';
  schemaId: string;
  schemaJson: string;
  /** `''` omits it (kernel default: SSE). */
  streamMode: '' | StreamMode;
  streamThoughts: boolean;
  validationEnabled: boolean;
  maxRetries: number | null;
  repairGuidance: string;
}

export interface TurnBehaviourDraft {
  resumeEnabled: boolean;
  allowContinue: ContinueStopKind[];
  autoContinue: ContinueStopKind[];
  maxContinues: number | null;
  continueInstruction: string;
  allowSteering: boolean;
}

export interface GuardrailsDraft {
  canary: boolean;
  canaryBindNote: string;
  sanitizeInput: boolean;
  redactSensitive: boolean;
  quotaEnabled: boolean;
  quotaPerDay: number | null;
  quotaMessage: string;
  /** Wires the kernel's `standardEgressEnforce`. */
  egressEnabled: boolean;
  egressOnBlock: EgressOnBlock | '';
  egressMaxRetries: number | null;
  egressRepairGuidance: string;
  egressHoldback: number | null;
  allowPrivateNetworks: boolean;
  allowedHosts: string[];
}

export interface ObservabilityDraft {
  writeTo: false | typeof PLAYGROUND_TRACE_DESTINATION;
  sampleRate: number;
  include: {
    upstreamLog: boolean;
    outboundWire: boolean;
    evidenceRaw: boolean;
    usage: boolean;
    guardrailDecisions: boolean;
    guardrailMatchPreview: boolean;
  };
  scrub: {
    sensitive: boolean;
    injection: boolean;
    canary: boolean;
  };
  retainForDays: number | null;
  rotateAfterMiB: number | null;
}

export interface ImageDraft {
  aspectRatio: string;
  size: string;
  mimeType: string;
  includeText: boolean;
}

export interface SpeechDraft {
  voice: string;
  format: '' | SpeechAudioFormat;
}

export interface LiveDraft {
  ingressAudio: boolean;
  ingressVideo: boolean;
  ingressText: boolean;
  voice: string;
  sessionResumption: boolean;
  proactiveAudio: boolean;
  /** Context window compression by sliding window; the two numbers are its trigger and target. */
  contextCompression: boolean;
  compressionTriggerTokens: number | null;
  compressionTargetTokens: number | null;
  transcriptionInput: boolean;
  transcriptionOutput: boolean;
  vadActivityHandling: '' | LiveActivityHandling;
  vadStartSensitivity: '' | LiveStartSensitivity;
  vadEndSensitivity: '' | LiveEndSensitivity;
  vadPrefixPaddingMs: number | null;
  vadSilenceDurationMs: number | null;
}

/** Wording the author replaced, by lexicon key; a key left out keeps the kernel's line. */
export type WordingDraft = Partial<Record<LexiconKey, string>>;

/** Wording held beside the setting it words; each line has one value, so it edits that field. */
export const INLINE_WORDING: Partial<Record<LexiconKey, ProfileGraphFacetId>> = {
  'continue.instruction': 'turnBehaviour',
  'canary.bind_note': 'guardrails',
  'quota.exhausted': 'guardrails',
  'repair.default_guidance': 'outputs',
  'egress.default_repair_guidance': 'guardrails',
};

export interface PlaygroundDraft {
  identity: IdentityDraft;
  /** Optional spine facets the author added (`PROFILE_GRAPH` rows with `optional`). */
  included: ProfileGraphFacetId[];
  models: ModelsDraft;
  modelBindings: ModelBindingDraft[];
  tools: ToolsDraft;
  toolSpecs: ToolSpecDraft[];
  inputs: InputsDraft;
  outputs: OutputsDraft;
  turnBehaviour: TurnBehaviourDraft;
  guardrails: GuardrailsDraft;
  observability: ObservabilityDraft;
  image: ImageDraft;
  speech: SpeechDraft;
  live: LiveDraft;
  wording: WordingDraft;
}

export function draftKey(prefix: 'model' | 'tool'): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function defaultModelBinding(partial?: Partial<ModelBindingDraft>): ModelBindingDraft {
  return {
    key: draftKey('model'),
    modelId: 'fast',
    protocol: 'openAi',
    provider: 'openrouter',
    apiId: '',
    efforts: [],
    defaultEffort: '',
    allowEffortSelect: false,
    summaries: null,
    maxOutputTokens: null,
    temperature: null,
    builtInTools: [],
    ...partial,
  };
}

export function defaultToolSpec(partial?: Partial<ToolSpecDraft>): ToolSpecDraft {
  return {
    key: draftKey('tool'),
    toolName: 'my_tool',
    toolType: 'function',
    description: 'Playground stub tool — returns a fixed result.',
    category: 'playground',
    access: TOOL_ACCESS[0],
    permission: TOOL_PERMISSION[0],
    loadTier: TOOL_LOAD_TIERS[0],
    paths: ['*'],
    inputJson: DEFAULT_TOOL_INPUT_SCHEMA,
    outputJson: DEFAULT_TOOL_OUTPUT_SCHEMA,
    ...partial,
  };
}

function defaultGuardrails(): GuardrailsDraft {
  const resolved = resolveGuardrailPolicy(undefined);
  return {
    canary: resolved.canary,
    canaryBindNote: '',
    sanitizeInput: resolved.sanitizeInput,
    redactSensitive: resolved.redactSensitive,
    quotaEnabled: false,
    quotaPerDay: null,
    quotaMessage: '',
    egressEnabled: false,
    egressOnBlock: '',
    egressMaxRetries: null,
    egressRepairGuidance: '',
    egressHoldback: null,
    allowPrivateNetworks: false,
    allowedHosts: [],
  };
}

function defaultObservability(): ObservabilityDraft {
  const resolved = resolveObservabilityPolicy(undefined);
  return {
    writeTo: PLAYGROUND_TRACE_DESTINATION,
    sampleRate: resolved.sampleRate,
    include: { ...resolved.include },
    scrub: { ...resolved.scrub },
    retainForDays: null,
    rotateAfterMiB: null,
  };
}

/**
 * An empty draft: no profile type chosen, every section at its kernel default
 * except observability, which the playground includes and points at its own
 * trace destination.
 */
export function createBlankDraft(): PlaygroundDraft {
  return {
    identity: { agentId: '', profileType: '', handle: '', system: '' },
    included: ['observability', 'wording'],
    models: { defaultModel: '', allowModelSelect: false, maxSteps: null, key: '' },
    modelBindings: [],
    tools: { t2Loader: '' },
    toolSpecs: [],
    inputs: {
      text: true,
      attachmentsAccept: [],
      voiceAccept: [],
      maxFiles: null,
      maxBytes: null,
      maxTurnBytes: null,
    },
    outputs: {
      mode: 'text',
      schemaId: '',
      schemaJson: '',
      streamMode: '',
      streamThoughts: true,
      validationEnabled: false,
      maxRetries: null,
      repairGuidance: '',
    },
    turnBehaviour: {
      resumeEnabled: false,
      allowContinue: [],
      autoContinue: [],
      maxContinues: null,
      continueInstruction: '',
      allowSteering: profileAllowsInject({ type: 'text' }),
    },
    guardrails: defaultGuardrails(),
    observability: defaultObservability(),
    image: { aspectRatio: '', size: '', mimeType: '', includeText: false },
    speech: { voice: '', format: '' },
    live: {
      ingressAudio: liveIngressChannelDefault('audio'),
      ingressVideo: liveIngressChannelDefault('video'),
      ingressText: liveIngressChannelDefault('text'),
      voice: '',
      sessionResumption: false,
      proactiveAudio: false,
      contextCompression: false,
      compressionTriggerTokens: null,
      compressionTargetTokens: null,
      transcriptionInput: false,
      transcriptionOutput: false,
      vadActivityHandling: '',
      vadStartSensitivity: '',
      vadEndSensitivity: '',
      vadPrefixPaddingMs: null,
      vadSilenceDurationMs: null,
    },
    wording: {},
  };
}

/** Required facets for the type plus the included optional ones, in catalog order. */
export function draftFacets(draft: PlaygroundDraft): ProfileGraphFacetId[] {
  const type = draft.identity.profileType;
  if (!type) return ['identity'];
  const included = new Set(draft.included);
  return PROFILE_GRAPH.filter(
    (facet) =>
      facet.role !== 'branch' &&
      facet.profileTypes.includes(type) &&
      (!facet.optional || included.has(facet.id)),
  ).map((facet) => facet.id);
}

/** By the kernel's `PROFILE_FIELD_SCOPE`; false until a type is chosen. */
export function draftAllows(draft: PlaygroundDraft, path: string): boolean {
  const type = draft.identity.profileType;
  return type !== '' && profileTypesForField(path).includes(type);
}

export function takesContinueInstruction(draft: PlaygroundDraft): boolean {
  const type = draft.identity.profileType;
  return type !== '' && CONTINUE_INSTRUCTION_TYPES.includes(type);
}

export function includableFacets(draft: PlaygroundDraft): ProfileGraphFacetId[] {
  const type = draft.identity.profileType;
  if (!type) return [];
  return PROFILE_GRAPH.filter(
    (facet) =>
      facet.role === 'spine' &&
      facet.optional &&
      facet.profileTypes.includes(type) &&
      !draft.included.includes(facet.id),
  ).map((facet) => facet.id);
}

/** Inputs an image profile can take: no voice, attachments within images, video and PDF. */
function imageInputs(inputs: InputsDraft): InputsDraft {
  return {
    ...inputs,
    attachmentsAccept: inputs.attachmentsAccept.filter((rule) =>
      mimeAllowed(IMAGE_ATTACHMENT_ACCEPT_MIMES, rule)
    ),
    voiceAccept: [],
  };
}

export function newModelBinding(draft: PlaygroundDraft): ModelBindingDraft {
  const type = draft.identity.profileType || 'text';
  const taken = new Set(draft.modelBindings.map((binding) => binding.modelId));
  const seed = defaultBindingForProfileType(type);
  let modelId = seed.modelId;
  for (let n = 2; taken.has(modelId); n++) modelId = `${seed.modelId}${n}`;
  return defaultModelBinding({ ...seed, modelId });
}

export function newToolSpec(draft: PlaygroundDraft): ToolSpecDraft {
  const taken = new Set(draft.toolSpecs.map((tool) => tool.toolName));
  let toolName = 'my_tool';
  for (let n = 2; taken.has(toolName); n++) toolName = `my_tool_${n}`;
  return defaultToolSpec({ toolName });
}

/**
 * Bindings the new type can't use are dropped; if none remain, one on the type's playground
 * default replaces them, and model select turns off below two bindings. Other sections and
 * `included` are kept, so a facet the type lacks comes back when switching back.
 */
export function setProfileType(
  draft: PlaygroundDraft,
  type: PlaygroundProfileType,
): PlaygroundDraft {
  const kept = draft.modelBindings.filter((binding) =>
    isValidProfileProtocol(type, binding.protocol) && !servesOtherProfileType(type, binding)
  );
  const retyped: PlaygroundDraft = {
    ...draft,
    identity: { ...draft.identity, profileType: type },
    modelBindings: kept,
  };
  const modelBindings = kept.length ? kept : [newModelBinding(retyped)];
  const modelIds = new Set(modelBindings.map((binding) => binding.modelId));
  const needsKey = !draft.models.key &&
    modelBindings.some((binding) => isGoogleTransport(binding.protocol, binding.provider));
  return {
    ...retyped,
    inputs: type === 'image' ? imageInputs(draft.inputs) : draft.inputs,
    models: {
      ...draft.models,
      defaultModel: modelIds.has(draft.models.defaultModel) ? draft.models.defaultModel : '',
      allowModelSelect: draft.models.allowModelSelect && modelBindings.length > 1,
      key: needsKey ? OVERFLOW_KEY_SLOTS[0] : draft.models.key,
    },
    modelBindings,
  };
}

export function includeFacet(draft: PlaygroundDraft, id: ProfileGraphFacetId): PlaygroundDraft {
  if (!includableFacets(draft).includes(id)) return draft;
  return { ...draft, included: [...draft.included, id] };
}

/** Its values stay on the draft for when it comes back. */
export function excludeFacet(draft: PlaygroundDraft, id: ProfileGraphFacetId): PlaygroundDraft {
  return { ...draft, included: draft.included.filter((facet) => facet !== id) };
}
