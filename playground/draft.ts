/**
 * Every section is always present so switching profile type keeps what the author typed.
 * "Provider default" numbers are `null` and booleans hold the value the kernel would resolve,
 * so compile emits a field only when it differs.
 */

import {
  type LexiconKey,
  liveIngressChannelDefault,
  profileAllowsInject,
  resolveGuardrailPolicy,
} from '../mod.ts';
import { BOUNDARIES, type Boundary, recordOf } from '../src/guardrails/boundaries.ts';
import {
  type DetectAction,
  DETECTORS,
  type Detector,
  detects,
  PATTERN_DETECTORS,
  type UrlDetector,
} from '../src/guardrails/detectors.ts';
import type { BlockedReplyOnBlock, DestinationGate, TaintGate } from '../src/guardrails/types.ts';
import { resolveObservabilityPolicy } from '../src/observability/mod.ts';
import { mimeAllowed } from '../src/kernel/registry/catalog.ts';
import { profileTypesForField } from '../src/kernel/profile-scope.ts';
import { CONTINUE_INSTRUCTION_TYPES } from '../src/kernel/stop.ts';
import {
  type CacheMode,
  type CompactionMeter,
  type CompactionTiming,
  type CacheTtl,
  type ContextSender,
  type ContinueStopKind,
  IMAGE_ATTACHMENT_ACCEPT_MIMES,
  isValidProfileProtocol,
  type KeySlot,
  type LiveActivityHandling,
  type LiveEndSensitivity,
  type LiveStartSensitivity,
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
  PLAYGROUND_TRACE_DESTINATION,
  servesOtherProfileType,
} from './policy.ts';
import { DEFAULT_TOOL_INPUT_SCHEMA, DEFAULT_TOOL_OUTPUT_SCHEMA } from './tool-schema.ts';
import type { PlaygroundToolSpecSeed } from './types.ts';

export type PlaygroundProfileType = ProfileType;

/** The types that run a model turn; a decision asks questions, and a host runs its tools. */
export type PlaygroundTurnProfileType = Exclude<PlaygroundProfileType, 'decision' | 'host'>;

export const PLAYGROUND_PROFILE_TYPES: readonly PlaygroundProfileType[] = PROFILE_TYPES;

export interface IdentityDraft {
  agentId: string;
  profileType: PlaygroundProfileType | '';
  handle: string;
  /** Private sections are wrapped as `{private: …}`. Unused on speech, which has no system channel. */
  system: string;
  /** Other instructions by the role a turn names, as a JSON object of strings (with `{private: …}` sections) or parts; blank omits it. */
  systemByRoleJson: string;
}

export interface ModelsDraft {
  defaultModel: string;
  allowModelSelect: boolean;
  /** `null` omits it: the kernel's default cap applies. */
  maxSteps: number | null;
  /** The vault slot every model uses unless it names its own. */
  key: KeySlot | '';
  /** The slot a quota refusal retries on once; `''` or absent names none. */
  fallbackKey?: KeySlot | '';
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
  /** Decision request timeout; `null` uses the playground timeout. */
  timeoutMs: number | null;
  efforts: EffortDraft[];
  defaultEffort: string;
  allowEffortSelect: boolean;
  /** Thought summaries: on, off, or `null` to leave it to the provider. */
  summaries: boolean | null;
  maxOutputTokens: number | null;
  temperature: number | null;
  builtInTools: string[];
  /** Google stores the interaction: on, off, or `null` for Google's default. Gemini Interactions only. */
  store: boolean | null;
  /**
   * Gemini Interactions only, and required there: `true` chains on Google's
   * stored interaction so Google builds the context; `false` sends the host's
   * history plus this turn's steps.
   */
  persistViaInteractionId: boolean;
  /** This model's own vault slot; `''` or absent uses the profile's. */
  keySlot?: KeySlot | '';
  /** This model's own fallback slot; `''` or absent uses the profile's. */
  fallbackKeySlot?: KeySlot | '';
  /** Prompt caching, OpenRouter only; `''` or absent leaves it off. */
  cacheMode?: CacheMode | '';
  /** How long a cached prompt lasts; `''` or absent is the provider's default. */
  cacheTtl?: CacheTtl | '';
  /** The local server running the model, recorded on traces; local models only. */
  server?: string;
  /** When the agent compacts its own history; `''` or absent leaves compaction off. Text only. */
  compactTiming?: CompactionTiming | '';
  /** The token budget `compactAt` is a fraction of. */
  compactMaxTokens?: number | null;
  /** The fraction of the budget, between 0 and 1, at which compaction starts. */
  compactAt?: number;
  /** Recent history kept word for word: exchanges, a fraction of the budget, or 0 for none. */
  compactKeep?: number | null;
  /** What counts toward the budget; `''` or absent is history. */
  compactMeter?: CompactionMeter | '';
  /** The workspace agent that writes the summary, by key; `''` or absent: this agent. */
  compactWith?: string;
}

/** Where compaction starts when a builder turns it on; every number stays theirs to change. */
export const COMPACTION_DRAFT_DEFAULTS = {
  compactMaxTokens: 32_000,
  compactAt: 0.75,
  compactKeep: 4,
} as const satisfies Partial<ModelBindingDraft>;

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
  /** Size limits by file type, as a JSON object of byte counts; blank omits it. */
  limitsByMimeJson: string;
  /** Named choices a turn can make, as a JSON object of value lists; blank omits it. */
  slotsJson: string;
  /** Who may send the agent context; none omits `inputs.context`. */
  contextFrom: ContextSender[];
  /** The longest context package from each sender, in characters of JSON. */
  contextMaxChars: number | null;
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

/** What a URL detector lets through besides the URLs the model was given. */
export interface UrlAllowDraft {
  hosts: string[];
  fromTools: boolean;
}

/** One pattern of the builder's own: a regular expression, or words matched whole. */
export interface PatternDraft {
  name: string;
  kind: 'pattern' | 'words';
  /** The regular expression's source, while `kind` is `pattern`. */
  pattern: string;
  /** Its flags, from `i`, `m`, `s` and `u`. */
  flags: string;
  /** The words, while `kind` is `words`. */
  words: string[];
}

/** Whose patterns a detector reads with: Theorem's, the builder's, both or neither. */
export interface PatternSourceDraft {
  theorem: boolean;
  patterns: PatternDraft[];
  /** What a retry tells the model about a match of the builder's patterns. `''` keeps the lexicon's. */
  hint: string;
}

/** A detector of the builder's own, read with its patterns. */
export interface OwnDetectorDraft {
  /** `namespace.name`. */
  key: string;
  label: string;
  /** What it does with a match, at every boundary. */
  at: Record<Boundary, DetectAction>;
  patterns: PatternDraft[];
  /** What a retry tells the model about a match. `''` keeps the lexicon's. */
  hint: string;
}

export interface GuardrailsDraft {
  /** The note that binds the canary, while `canary_leak` reads somewhere. */
  canaryBindNote: string;
  /** What each detector does with a match, at every boundary. */
  detect: Record<Detector, Record<Boundary, DetectAction>>;
  /** Whose patterns each detector that reads with patterns uses, by detector. */
  sources: Record<string, PatternSourceDraft>;
  /** Detectors of the builder's own. */
  own: OwnDetectorDraft[];
  quotaEnabled: boolean;
  quotaPerDay: number | null;
  quotaMessage: string;
  /** What `ungiven_images` and `ungiven_links` let through. */
  allow: Record<UrlDetector, UrlAllowDraft>;
  /** The names of tools and parameters `tool_leak` lets through. */
  innocentNames: string[];
  /** `''` omits it (kernel default: retry). */
  blockedReplyOnBlock: BlockedReplyOnBlock | '';
  /** `null` omits it (kernel default: 1). */
  blockedReplyMaxRetries: number | null;
  egressRepairGuidance: string;
  allowPrivateNetworks: boolean;
  allowedHosts: string[];
  /** Empty omits it: https, plus http with private networks. */
  allowedSchemes: string[];
  /** `''` omits it (kernel default: off). */
  taintAfterRemoteRead: TaintGate | '';
  /** `''` omits it (kernel default: off). */
  taintRemoteDestination: DestinationGate | '';
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
  /** Attributes on every trace, as a JSON object; blank omits it. */
  resourceJson: string;
}

/** A pinned reference image: a file's bytes, or a link to one. */
export type ImageReferenceDraft =
  | { key: string; name: string; mimeType: string; data: string }
  | { key: string; uri: string };

export interface ImageDraft {
  aspectRatio: string;
  resolution: string;
  mimeType: string;
  /** Provider vocabularies (OpenRouter: auto, low, medium, high); blank is the provider default. */
  quality: string;
  /** Provider vocabularies (OpenRouter: auto, transparent, opaque); blank is the provider default. */
  background: string;
  n: number | null;
  seed: number | null;
  outputCompression: number | null;
  includeText: boolean;
  references: ImageReferenceDraft[];
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
  /** The prompt a new call opens with, so the agent speaks first; blank omits it. */
  greeting: string;
  /** The prompt a resumed call opens with; blank omits `live.resumed`. */
  resumedPrompt: string;
  resumedAfterMs: number | null;
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

export type DecisionQuestionType = 'choice' | 'score' | 'noul';

/** A choice's option or a number's named criterion (`label`), or a score's level (`text` only). */
export interface DecisionCriterionDraft {
  key: string;
  label: string;
  text: string;
}

export interface DecisionQuestionDraft {
  key: string;
  id: string;
  type: DecisionQuestionType;
  instructions: string;
  /** A score's levels run from 0 at the top. */
  criteria: DecisionCriterionDraft[];
}

/** A decision profile and the questions it asks. The state they are asked about is typed where it runs, not saved. */
export interface DecisionDraft {
  contract: string;
  /** `null` is the playground's most. */
  maxStateBytes: number | null;
  questions: DecisionQuestionDraft[];
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
  decision: DecisionDraft;
  wording: WordingDraft;
}

export function draftKey(
  prefix: 'agent' | 'model' | 'tool' | 'question' | 'criterion' | 'reference',
): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function defaultModelBinding(partial?: Partial<ModelBindingDraft>): ModelBindingDraft {
  return {
    key: draftKey('model'),
    modelId: 'fast',
    protocol: 'openAi',
    provider: 'openrouter',
    apiId: '',
    timeoutMs: null,
    efforts: [],
    defaultEffort: '',
    allowEffortSelect: false,
    summaries: null,
    maxOutputTokens: null,
    temperature: null,
    builtInTools: [],
    store: null,
    persistViaInteractionId: false,
    ...partial,
  };
}

const STUB_TOOL_DESCRIPTION = 'Playground stub tool — returns a fixed result.';

export function defaultToolSpec(partial?: Partial<ToolSpecDraft>): ToolSpecDraft {
  return {
    key: draftKey('tool'),
    toolName: 'my_tool',
    toolType: 'function',
    description: STUB_TOOL_DESCRIPTION,
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

/**
 * The change that points an agent tool at an agent. A description that is
 * still the new tool's stub, or empty, comes to say what the tool now does.
 */
export function agentToolTarget(
  tool: ToolSpecDraft,
  agentKey: string,
  agentId: string,
): Partial<ToolSpecDraft> {
  const isStub = !tool.description.trim() || tool.description === STUB_TOOL_DESCRIPTION;
  return isStub && agentId ? { agentKey, description: `Asks ${agentId} and returns its answer.` } : { agentKey };
}

/** A pattern to fill in. */
export function newPattern(): PatternDraft {
  return { name: '', kind: 'words', pattern: '', flags: '', words: [] };
}

/** A detector of the builder's own to fill in: it reads nowhere until a boundary is set. */
export function newOwnDetector(): OwnDetectorDraft {
  return {
    key: '',
    label: '',
    at: recordOf(BOUNDARIES, () => 'ignore' as const),
    patterns: [newPattern()],
    hint: '',
  };
}

function defaultGuardrails(): GuardrailsDraft {
  const resolved = resolveGuardrailPolicy(undefined);
  return {
    canaryBindNote: '',
    detect: recordOf(DETECTORS, (detector) => ({ ...resolved.detect[detector] })),
    sources: Object.fromEntries(
      PATTERN_DETECTORS.map((detector) => [detector, { theorem: true, patterns: [], hint: '' }]),
    ),
    own: [],
    quotaEnabled: false,
    quotaPerDay: null,
    quotaMessage: '',
    allow: {
      ungiven_images: { hosts: [], fromTools: true },
      ungiven_links: { hosts: [], fromTools: true },
    },
    innocentNames: [],
    blockedReplyOnBlock: '',
    blockedReplyMaxRetries: null,
    egressRepairGuidance: '',
    allowPrivateNetworks: false,
    allowedHosts: [],
    allowedSchemes: [],
    taintAfterRemoteRead: '',
    taintRemoteDestination: '',
  };
}

function defaultObservability(): ObservabilityDraft {
  const resolved = resolveObservabilityPolicy(undefined);
  return {
    writeTo: PLAYGROUND_TRACE_DESTINATION,
    sampleRate: resolved.sampleRate,
    include: { ...resolved.include },
    scrub: {
      sensitive: Boolean(resolved.scrub.sensitive),
      injection: Boolean(resolved.scrub.injection),
      canary: Boolean(resolved.scrub.canary),
    },
    retainForDays: null,
    rotateAfterMiB: null,
    resourceJson: '',
  };
}

function criteria(entries: ReadonlyArray<[label: string, text: string]>): DecisionCriterionDraft[] {
  return entries.map(([label, text]) => ({ key: draftKey('criterion'), label, text }));
}

/** A guardrail on a tool call the agent is about to make: whether to let it run, and how much is at stake. */
export function exampleDecisionDraft(): DecisionDraft {
  return {
    contract: 'guardrails.tool_call.v1',
    maxStateBytes: null,
    questions: [
      {
        key: draftKey('question'),
        id: 'verdict',
        type: 'choice',
        instructions: 'Given what the user asked for and what the call would do, should it run?',
        criteria: criteria([
          ['allow', 'Safe, and what the user asked for.'],
          ['flag', 'Probably fine, but unusual or sensitive enough for a person to look first.'],
          ['block', 'Harmful, or clearly beyond what the user asked for.'],
        ]),
      },
      {
        key: draftKey('question'),
        id: 'risk',
        type: 'score',
        instructions: 'How much harm would this call do if it were wrong?',
        criteria: criteria([
          ['', 'Low: reversible, and affects only the user.'],
          ['', 'High: hard to undo, or affects other people or money.'],
        ]),
      },
    ],
  };
}

/** State the example's questions can be asked about: the field a decision preview starts with. */
export const EXAMPLE_DECISION_STATE = JSON.stringify(
  {
    context: 'The user asked the agent to tidy up old screenshots on their desktop.',
    tool_call: { name: 'delete_files', path: '~/Documents', recursive: true },
    outcome: 'Would delete 1,284 files, including tax_return_2025.pdf.',
  },
  null,
  2,
);

/** Span accepts a JSON string state; the preview starts with that shape for Span models. */
export const EXAMPLE_SPAN_DECISION_STATE = JSON.stringify(
  'The user asked to tidy screenshots. The proposed call recursively deletes 1,284 files, including a tax return.',
);

/** A new question of `type`, with an id the draft doesn't use yet. */
export function newDecisionQuestion(
  draft: PlaygroundDraft,
  type: DecisionQuestionType = 'choice',
): DecisionQuestionDraft {
  const taken = draft.decision.questions.map((question) => question.id);
  const id = freeName('question', taken, (n) => `question_${n}`);
  return { key: draftKey('question'), id, type, instructions: '', criteria: newCriteria(type) };
}

/** The rows a question of `type` starts with: two options, two levels, or none. */
export function newCriteria(type: DecisionQuestionType): DecisionCriterionDraft[] {
  if (type === 'noul') return [];
  return criteria(type === 'choice' ? [['yes', ''], ['no', '']] : [['', ''], ['', '']]);
}

/**
 * An empty draft: no profile type chosen, every section at its kernel default
 * except observability, which the playground includes and points at its own
 * trace destination.
 */
export function createBlankDraft(): PlaygroundDraft {
  return {
    identity: { agentId: '', profileType: '', handle: '', system: '', systemByRoleJson: '' },
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
      limitsByMimeJson: '',
      slotsJson: '',
      contextFrom: [],
      contextMaxChars: null,
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
    image: {
      aspectRatio: '',
      resolution: '',
      mimeType: '',
      quality: '',
      background: '',
      n: null,
      seed: null,
      outputCompression: null,
      includeText: false,
      references: [],
    },
    speech: { voice: '', format: '' },
    live: {
      ingressAudio: liveIngressChannelDefault('audio'),
      ingressVideo: liveIngressChannelDefault('video'),
      ingressText: liveIngressChannelDefault('text'),
      voice: '',
      sessionResumption: false,
      greeting: '',
      resumedPrompt: '',
      resumedAfterMs: null,
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
    decision: exampleDecisionDraft(),
    wording: {},
  };
}

/**
 * Facets a decision draft leaves out: its only guardrail is a host's disclosure
 * hook, which a draft can't carry, and the playground doesn't trace a decision.
 */
const DECISION_HIDDEN_FACETS: ReadonlySet<ProfileGraphFacetId> = new Set([
  'guardrails',
  'observability',
]);

function facetFits(facet: (typeof PROFILE_GRAPH)[number], type: PlaygroundProfileType): boolean {
  return facet.profileTypes.includes(type) &&
    !(type === 'decision' && DECISION_HIDDEN_FACETS.has(facet.id));
}

/** Required facets for the type plus the included optional ones, in catalog order. */
export function draftFacets(draft: PlaygroundDraft): ProfileGraphFacetId[] {
  const type = draft.identity.profileType;
  if (!type) return ['identity'];
  const included = new Set(draft.included);
  return PROFILE_GRAPH.filter(
    (facet) =>
      facet.role !== 'branch' &&
      facetFits(facet, type) &&
      (!facet.optional || included.has(facet.id)),
  ).map((facet) => facet.id);
}

/** By the kernel's `PROFILE_FIELD_SCOPE`; false until a type is chosen. */
export function draftAllows(draft: PlaygroundDraft, path: string): boolean {
  const type = draft.identity.profileType;
  return type !== '' && profileTypesForField(path).includes(type);
}

/** A canary is bound into a system prompt while `canary_leak` reads somewhere. */
export function plantsCanary(draft: PlaygroundDraft): boolean {
  return draftAllows(draft, 'identity.system') && detects(draft.guardrails.detect, 'canary_leak');
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
      facetFits(facet, type) &&
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

/** Updates a binding and keeps the default model attached to it through an id change. */
export function updateModelBinding(
  draft: PlaygroundDraft,
  bindingKey: string,
  change: Partial<ModelBindingDraft>,
): PlaygroundDraft {
  const binding = draft.modelBindings.find((candidate) => candidate.key === bindingKey);
  if (!binding) return draft;
  return {
    ...draft,
    models: change.modelId !== undefined && draft.models.defaultModel === binding.modelId
      ? { ...draft.models, defaultModel: change.modelId }
      : draft.models,
    modelBindings: draft.modelBindings.map((candidate) =>
      candidate.key === bindingKey ? { ...candidate, ...change } : candidate
    ),
  };
}

/**
 * Drops a binding, and the default model with it when it was that one. Model select turns off
 * below two bindings, as on a type switch.
 */
export function removeModelBinding(draft: PlaygroundDraft, bindingKey: string): PlaygroundDraft {
  const binding = draft.modelBindings.find((candidate) => candidate.key === bindingKey);
  if (!binding) return draft;
  const modelBindings = draft.modelBindings.filter((candidate) => candidate.key !== bindingKey);
  return {
    ...draft,
    models: {
      ...draft.models,
      defaultModel: draft.models.defaultModel === binding.modelId ? '' : draft.models.defaultModel,
      allowModelSelect: draft.models.allowModelSelect && modelBindings.length > 1,
    },
    modelBindings,
  };
}

export function newModelBinding(draft: PlaygroundDraft): ModelBindingDraft {
  const chosen = draft.identity.profileType;
  const type = chosen && chosen !== 'host' ? chosen : 'text';
  const taken = draft.modelBindings.map((binding) => binding.modelId);
  const seed = defaultBindingForProfileType(type);
  const modelId = freeName(seed.modelId, taken, (n) => `${seed.modelId}${n}`);
  return defaultModelBinding({ ...seed, modelId });
}

export function newToolSpec(draft: PlaygroundDraft): ToolSpecDraft {
  const taken = draft.toolSpecs.map((tool) => tool.toolName);
  return defaultToolSpec({ toolName: freeName('my_tool', taken, (n) => `my_tool_${n}`) });
}

/** `first` if nothing has taken it, else the first `nth(2)`, `nth(3)`, … that is free. */
export function freeName(first: string, taken: Iterable<string>, nth: (n: number) => string): string {
  const used = new Set(taken);
  let name = first;
  for (let n = 2; used.has(name); n++) name = nth(n);
  return name;
}

/**
 * Bindings the new type can't use are dropped; if none remain, one playground default replaces
 * them. Model select turns off below two bindings. Other sections and
 * `included` are kept, so a facet the type lacks comes back when switching back. A host runs no
 * model, so it keeps the bindings for the way back.
 */
export function setProfileType(
  draft: PlaygroundDraft,
  type: PlaygroundProfileType,
): PlaygroundDraft {
  if (type === 'host') {
    return { ...draft, identity: { ...draft.identity, profileType: type } };
  }
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
    modelBindings.some((binding) => !binding.keySlot && binding.provider !== 'local');
  return {
    ...retyped,
    inputs: type === 'image' ? imageInputs(draft.inputs) : draft.inputs,
    models: {
      ...draft.models,
      defaultModel: modelIds.has(draft.models.defaultModel) ? draft.models.defaultModel : '',
      allowModelSelect: draft.models.allowModelSelect && modelBindings.length > 1,
      key: needsKey ? DEFAULT_KEY_SLOT : draft.models.key,
    },
    modelBindings,
  };
}

// The slot the playground's server fills; named slots in the editor replace this.
const DEFAULT_KEY_SLOT: KeySlot = 'slot_a';

export function includeFacet(draft: PlaygroundDraft, id: ProfileGraphFacetId): PlaygroundDraft {
  if (!includableFacets(draft).includes(id)) return draft;
  return { ...draft, included: [...draft.included, id] };
}

/** Its values stay on the draft for when it comes back. */
export function excludeFacet(draft: PlaygroundDraft, id: ProfileGraphFacetId): PlaygroundDraft {
  return { ...draft, included: draft.included.filter((facet) => facet !== id) };
}
