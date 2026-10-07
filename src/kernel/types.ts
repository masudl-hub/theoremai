import type {
  CacheMode,
  CacheTtl,
  CompactionMeter,
  CompactionOutcome,
  CompactionTiming,
  ContextSender,
  ContinueStopKind,
  FieldMeta,
  KeySlot,
  KeyVault,
  LiveActivityHandling,
  LiveEndSensitivity,
  LiveStartSensitivity,
  MediaInputKind,
  ProfileType,
  ProfileTypeProtocol,
  Protocol,
  Provider,
  SpeechAudioFormat,
  StreamMode,
  SummaryMode,
  ThinkingLevel,
  ToolLoadTier,
  TurnStage,
  TurnStopKind,
} from './schema.ts';
import type { StageHandler } from './stages.ts';
import type { GateDecision } from './tools/gate-answer.ts';
import type {
  AgentCall,
  AgentCallHook,
  AgentCallRequest,
  AgentToolDef,
  AgentToolInput,
  AgentToolOutput,
  BuiltinWire,
  HostProfileToolsSpec,
  InvokeToolRequest,
  InvokeToolResume,
  LiveProfileToolsSpec,
  ModelToolResult,
  PageAnswer,
  ProfileToolsSpec,
  RegisteredTool,
  ToolCallEvent,
  ToolFailure,
  ToolGate,
  ToolLoadContext,
  ToolPolicy,
  TurnToolSnapshot,
  WireFunctionTool,
} from './tools/types.ts';
import type {
  CallDone,
  CompactionFailure,
  CompactionResult,
  CompactionSignal,
  DoneFields,
  GroundingEvent,
  InteractionMediaPart,
  InteractionMediaRefPart,
  InteractionPart,
  InteractionTextPart,
  ProviderEvent,
  ProviderEvidence,
  SessionEnded,
  SessionEvent,
  SessionEventKind,
  SessionEventOf,
  Source,
  TurnCost,
  TurnEvent,
  TurnEventOf,
  TurnEventType,
  TurnGroundingCount,
  TurnHistoryMessage,
  TurnResponse,
  TurnTokenSide,
  TurnTokens,
} from './turn-events.ts';

export type {
  AgentCall,
  AgentCallHook,
  AgentCallRequest,
  AgentToolDef,
  AgentToolInput,
  AgentToolOutput,
  CacheMode,
  CacheTtl,
  CallDone,
  CompactionFailure,
  CompactionMeter,
  CompactionOutcome,
  CompactionResult,
  CompactionSignal,
  CompactionTiming,
  ContinueStopKind,
  DoneFields,
  FieldMeta,
  GroundingEvent,
  HostProfileToolsSpec,
  InteractionMediaPart,
  InteractionMediaRefPart,
  InteractionPart,
  InteractionTextPart,
  InvokeToolRequest,
  InvokeToolResume,
  KeySlot,
  KeyVault,
  LiveActivityHandling,
  LiveEndSensitivity,
  LiveProfileToolsSpec,
  LiveStartSensitivity,
  MediaInputKind,
  ProfileToolsSpec,
  ProfileType,
  ProfileTypeProtocol,
  Protocol,
  Provider,
  ProviderEvent,
  ProviderEvidence,
  RegisteredTool,
  SessionEnded,
  SessionEvent,
  SessionEventKind,
  SessionEventOf,
  Source,
  SpeechAudioFormat,
  StreamMode,
  SummaryMode,
  ThinkingLevel,
  ToolCallEvent,
  ToolFailure,
  ToolGate,
  ToolLoadContext,
  ToolLoadTier,
  ToolPolicy,
  TurnCost,
  TurnEvent,
  TurnEventOf,
  TurnEventType,
  TurnGroundingCount,
  TurnHistoryMessage,
  TurnResponse,
  TurnStage,
  TurnStopKind,
  TurnTokenSide,
  TurnTokens,
  TurnToolSnapshot,
  WireFunctionTool,
};

/** A host-chosen key naming one model binding in a profile's `models`. */
export type ModelId = string;

/** The id of a provider-side tool such as web search. */
export type BuiltinToolId = string;
/** The id a profile lists in `tools.allow` and the model calls a tool by. */
export type ToolId = string;

/** The id of a registered structured-output schema. */
export type StructuredSchemaId = string;

/** A structured-output schema resolved to its JSON Schema. */
export interface ResolvedStructured {
  id: StructuredSchemaId;
  jsonSchema: Record<string, unknown>;
}

/** A provider-side tool and the wire shape it is sent as. */
export interface ProviderBuiltin {
  id: BuiltinToolId;
  wire: BuiltinWire;
}

/** The id a profile is registered and run under. */
export type ProfileId = string;

/** The roles a history message can carry. */
export type ChatRole = 'system' | 'user' | 'assistant';

/** Host strings (presets own the vocabularies); an unpinned value is the provider default. */
export interface ProfileImageSpec {
  aspectRatio?: string;
  resolution?: string;
  mimeType?: string;
  quality?: string;
  background?: string;
  n?: number;
  seed?: number;
  outputCompression?: number;
  references?: Array<TurnBlob | TurnMediaRef>;
  /** Also request interleaved text with the images (Google: text + image `response_format`). */
  includeText?: boolean;
}

/** One model a profile can run: the protocol, provider and provider model id it calls, with its generation settings. */
export interface ModelBinding {
  protocol: Protocol;
  provider: Provider;
  apiId: string;
  /** Alias → thinking level. One entry = fixed; two+ may be selectable at turn time. */
  efforts?: Record<string, ThinkingLevel>;
  /** Effort alias when the turn omits `effort`. Defaults to the only key when there is one. */
  defaultEffort?: string;
  /** Turn may pass `{ effort: "<alias>" }`. Requires two or more `efforts` keys. */
  allowEffortSelect?: boolean;
  /** Emit thinking summaries on the stream. Omit → provider default. */
  summaries?: boolean;
  /** Cap on output tokens. Omit → provider default. */
  maxOutputTokens?: number;
  /** Sampling temperature. Omit → provider default. */
  temperature?: number;
  builtInTools?: BuiltinToolId[];
  /** Overrides `profile.key` for this model. */
  key?: KeySlot;
  /** Overrides `profile.fallbackKey` for this model. */
  fallbackKey?: KeySlot;
  compaction?: CompactionSpec;
  /**
   * OpenRouter prompt-cache policy. Omit → no opt-in `cache_control`.
   * `defineProfile` accepts only when `provider` is `openrouter` (protocol `openAi`).
   */
  cache?: CacheSpec;
  /** Gemini Interactions: whether the provider stores the interaction. Omit → provider default. */
  store?: boolean;
  /**
   * Gemini Interactions: `true` chains each step and turn on Google's stored
   * interaction (`previous_interaction_id`), so Google builds the context;
   * `false` sends the history the host passes, plus this turn's steps, on every
   * call — across turns the host builds that history. Required on every
   * `geminiInteractions` binding; `true` needs `store` left on.
   */
  persistViaInteractionId?: boolean;
  /**
   * Local server that hosts the model (e.g. `ollama`, `vllm`, `llama.cpp`).
   * Traces report it as `gen_ai.provider.name`; omit → the attribute is absent.
   * `defineProfile` accepts only when `provider` is `local`.
   */
  server?: string;
}

/**
 * OpenRouter prompt-cache policy (`models.*.cache`).
 *
 * - `automatic` — top-level `cache_control`; breakpoint advances with the conversation.
 * - `system` — explicit breakpoint on the system instruction only.
 */
export interface CacheSpec {
  mode: CacheMode;
  /** Ephemeral TTL. Omit → provider default (typically 5m on Anthropic). */
  ttl?: CacheTtl;
}

/** What a compaction trigger sees when it decides whether to compact. */
export interface CompactionTriggerContext {
  tokens: number;
  maxTokens: number;
  compactAt: number;
  meter: CompactionMeter;
  /** Media parts not counted in `tokens` — no verified rule for this model. */
  unknownMedia: number;
}

/** When history compacts and how: the meter, the token budget and the compactor. */
export interface CompactionSpec {
  /**
   * Token budget compared by the trigger (`compactAt * maxTokens`).
   * Meaning depends on `meter`: history budget vs full-prompt input budget.
   */
  maxTokens: number;
  /** Fraction of `maxTokens` at which compaction fires. Must be in (0, 1). */
  compactAt: number;
  /**
   * Recent exchanges kept verbatim (an exchange is a user message and everything up to the
   * next one). `≥ 1` = exchange count, `(0, 1)` = fraction of `maxTokens`, `0` = compact all.
   */
  previousExchanges: number;
  /**
   * Profile id of the compaction agent. Must be registered before the owning profile.
   * Omit it and the agent compacts its own history: the same instructions and model, no tools.
   */
  profile?: ProfileId;
  /**
   * When compaction runs relative to the primary turn.
   * - `'before'`: kernel compacts synchronously before the turn; user pays latency on this turn.
   * - `'after'`: kernel signals in the `done` event; host runs compaction asynchronously.
   */
  timing: CompactionTiming;
  /**
   * Threshold meter. Defaults to `'history'`.
   * Use `'input'` when the host prefers provider full-prompt usage (after
   * subtracting a known baseline in `maxTokens` / `compactAt`).
   */
  meter?: CompactionMeter;
  /** Replaces the default `tokens > compactAt * maxTokens` check. */
  trigger?: (ctx: CompactionTriggerContext) => boolean | Promise<boolean>;
}

/** `compactHistory` input, for `timing: 'after'`: the host passes back what `done.compaction` carried. */
export interface CompactHistoryRequest {
  /** The profile whose model binding carries the `compaction` spec. */
  profile: ProfileId;
  /** That binding; defaults to the profile's `defaultModel`. */
  model?: ModelId;
  history: TurnHistoryMessage[];
  /** `done.compaction.tokens`: a failed compactor drops `toCompact` only when this is over `maxTokens`. */
  tokens: number;
  signal?: AbortSignal;
  traceparent?: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
}

/** A structured-output schema given inline. */
export interface StructuredSpec {
  jsonSchema: Record<string, unknown>;
}

/** Caps on the files a turn may attach. */
export interface MediaLimits {
  maxFiles: number;
  maxBytes: number;
  maxTurnBytes: number;
  limitsByMime?: Record<string, number>;
}

/** The input kinds a profile accepts, with their limits. */
export interface MimeInputs extends Partial<MediaLimits> {
  text?: boolean;
  attachments?: { accept: string[] };
  voice?: { accept: string[] };
}

/** Why an attachment was refused. */
export type AttachmentValidationCode =
  | 'mime_not_allowed'
  | 'too_many_files'
  | 'file_too_large'
  | 'turn_too_large'
  | 'attachments_not_accepted'
  | 'voice_not_accepted'
  | 'limits_unconfigured';

/**
 * Structured parameters for rendering one validation issue. Validation emits
 * codes + params only; the wording is the lexicon's `attachments.*` lines.
 */
export interface AttachmentValidationParams {
  maxFiles?: number;
  maxBytes?: number;
  maxTurnBytes?: number;
  mimeType?: string;
  channel?: 'attachment' | 'voice';
}

/** One reason a turn's files were refused; `fileName` names the file when the problem is one file's. */
export interface AttachmentValidationIssue {
  code: AttachmentValidationCode;
  params?: AttachmentValidationParams;
  fileName?: string;
}

/** Picks the structured-output schema by the value of a turn slot, with a fallback. */
export interface StructuredBySlot {
  by: string;
  map: Record<string, string>;
  fallback: string;
}

/** What a host validator returns for a candidate output. */
export interface ValidationResult {
  isValid: boolean;
  error?: string;
  finding?: string;
  data?: Record<string, unknown>;
}

/** A host function that checks one structured-output field. */
export type ProfileValidator = (
  candidate: unknown,
  slots?: Record<string, string>,
) => ValidationResult | Promise<ValidationResult>;

/** Host validators a profile runs on its structured output. */
export interface ProfileValidationSpec {
  /**
   * Host domain validators keyed by dotted paths into structured output
   * (e.g. `diagram.mermaid`). Presence/required is owned by the JSON Schema;
   * these run only for required paths and for optional paths that are present.
   */
  fields?: Record<string, ProfileValidator>;
  maxRetries?: number;
}

/** `voice` is the TTS voice id, not ingress audio (`inputs.voice`). */
export interface ProfileSpeechSpec {
  voice?: string;
  /** How the script is delivered, in plain words: pace, mood, accent. Never read aloud. */
  style?: string;
  /** The speaking rate; 1 is the voice's own pace. */
  speed?: number;
  /** `mp3` requires `protocol: 'openAi'` speech; rejected on Interactions. */
  format?: SpeechAudioFormat;
}

/** What one speech turn sets for itself; each field given replaces the profile's `speech` field of that name. */
export type TurnSpeech = Pick<ProfileSpeechSpec, 'voice' | 'style' | 'speed'>;

/** Voice activity detection settings for a live session. */
export interface LiveVadSpec {
  activityHandling?: LiveActivityHandling;
  startSensitivity?: LiveStartSensitivity;
  endSensitivity?: LiveEndSensitivity;
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
}

/**
 * Context window compression for a live session: once the context reaches the
 * trigger, the mechanism shrinks it. Without it, Gemini ends audio sessions at
 * 15 minutes and audio-video sessions at 2.
 */
export interface LiveContextCompressionSpec {
  /**
   * Context tokens, counted before a turn, that start compression. A whole
   * number above 0. Omit → provider default (Gemini: 80% of the model's context
   * window).
   */
  triggerTokens?: number;
  /** Drops the oldest turns; the system instruction stays. Gemini's only mechanism. */
  slidingWindow: LiveSlidingWindowSpec;
}

/** Sliding-window context compression for a live session. */
export interface LiveSlidingWindowSpec {
  /**
   * Tokens to keep after compressing. A whole number above 0, below
   * `triggerTokens`. Omit → provider default (Gemini: half of `triggerTokens`).
   */
  targetTokens?: number;
}

/** Which sides of a live session are transcribed. */
export interface LiveTranscriptionSpec {
  input?: boolean;
  output?: boolean;
}

/**
 * Realtime ingress modalities for a live session.
 * Distinct from turn `inputs` (file attachments, MIME limits) — these gate
 * `LiveSession.sendAudio` / `sendVideo` / `sendText` channels.
 */
export interface LiveIngressSpec {
  /** Microphone PCM via `sendAudio`. Omit → enabled. */
  audio?: boolean;
  /** Webcam JPEG frames via `sendVideo`. Omit → enabled. */
  video?: boolean;
  /** Typed text via `sendText`. Omit → disabled (opt-in). */
  text?: boolean;
}

/** The prompt a resumed call opens with, and how long away earns it. */
export interface LiveResumedSpec {
  prompt: string;
  /** The shortest time away, in milliseconds, the agent remarks on. Omit → `DEFAULT_RESUMED_AFTER_MS`. */
  afterMs?: number;
}

/** The settings only a live profile has: ingress, voice, detection, windowing, transcription and resumption. */
export interface ProfileLiveSpec {
  ingress?: LiveIngressSpec;
  voice?: string;
  vad?: LiveVadSpec;
  sessionResumption?: boolean;
  /** A prompt the session sends itself when a call opens new, so the agent speaks first. Omit → the agent waits. */
  greeting?: string;
  /** What the agent is prompted with when a call resumes after the caller was away. Omit → a resumed call is silent. */
  resumed?: LiveResumedSpec;
  /** Context window compression. Omit → none: the provider ends the session at its limit. */
  contextCompression?: LiveContextCompressionSpec;
  transcription?: LiveTranscriptionSpec;
}

/** How a profile's reply streams. */
export interface ProfileStreamingSpec {
  mode?: StreamMode;
  /** When false, filter `thought` events from the turn stream. */
  streamThoughts?: boolean;
}

export type {
  MediaTurnBehaviourSpec,
  ProfileTurnBehaviourSpec,
  ProfileTurnResumptionSpec,
  TurnContinueFrom,
  TurnStop,
} from './stop.ts';

import type { LexiconOverrides } from '../guardrails/lexicon.ts';
import type { ResolveHost } from '../guardrails/network.ts';
import type {
  DecisionGuardrailsSpec,
  HostGuardrailsSpec,
  ProfileGuardrailsSpec,
} from '../guardrails/types.ts';
import type { ProfileObservabilitySpec } from '../observability/types.ts';
import type { ToolCredentialSource } from './auth/credential-source.ts';
import type { MediaTurnBehaviourSpec, ProfileTurnBehaviourSpec, TurnContinueFrom } from './stop.ts';

/** The model fields every model-running profile shares. */
export interface ProfileModelFields {
  /** Host-named models. Each key is a selectable model id when `allowModelSelect` is set. */
  models: Record<ModelId, ModelBinding>;
  /** The model a turn runs when it names none; registration fills it with the only key when there is one. */
  defaultModel: ModelId;
  /** Turn may pass `{ model: "<id>" }`. Requires two or more `models` keys. */
  allowModelSelect?: boolean;
  /** Tool-loop ceiling. Omit = `DEFAULT_MAX_STEPS`; `1` = one-shot; `> 1` = hard cap. */
  maxSteps?: number;
  key?: KeySlot;
  /** Retried once when `key` is refused for quota. Off unless set. */
  fallbackKey?: KeySlot;
}

/** What a profile accepts as input. */
export interface ProfileInputsSpec {
  text?: boolean;
  attachments?: { accept: string[] };
  voice?: { accept: string[] };
  maxFiles?: number;
  maxBytes?: number;
  maxTurnBytes?: number;
  limitsByMime?: Record<string, number>;
  slots?: Record<string, string[]>;
  context?: ProfileContextSpec;
}

/** What a live profile declares beside its ingress channels. */
export type LiveInputsSpec = Pick<ProfileInputsSpec, 'slots' | 'context'>;

/** Who may send a turn its context, and how much. */
export interface ProfileContextSpec {
  from: ContextSender[];
  maxChars: number;
}

/** The context each sender gives a turn: any JSON, or text. */
export type TurnContext = Partial<Record<ContextSender, unknown>>;

/** What a profile returns: its structured schema, validation and streaming. */
export interface ProfileOutputsSpec {
  structured?: StructuredSchemaId | StructuredBySlot | null;
  validation?: ProfileValidationSpec;
  streaming?: ProfileStreamingSpec;
}

/** Text a reply may not repeat when the rest of its prompt is marked shareable. */
export interface PrivateSystemPart {
  private: string;
}

/** One part of a system prompt: plain text or a part kept out of traces. */
export type SystemPart = string | PrivateSystemPart;

/**
 * A system prompt: a string, or parts sent concatenated as written. A string,
 * or parts none of which is `{ private }`, is private throughout; once one
 * part is `{ private }`, the plain strings beside it are shareable.
 */
export type SystemPrompt = string | readonly SystemPart[];

/** A stretch of the system prompt as sent, and whether a reply may repeat it. */
export interface SystemPiece {
  text: string;
  private: boolean;
}

/** A profile's handle and system prompt. */
export interface ProfileIdentity {
  handle: string;
  system?: SystemPrompt;
  systemByRole?: Record<string, SystemPrompt>;
}

/** The fields every profile type shares. */
export interface ProfileCommon {
  id: ProfileId;
  identity: ProfileIdentity;
  models: Record<ModelId, ModelBinding>;
  defaultModel: ModelId;
  allowModelSelect?: boolean;
  maxSteps?: number;
  key?: KeySlot;
  /** Retried once when `key` is refused for quota. Off unless set. */
  fallbackKey?: KeySlot;
  outputs?: ProfileOutputsSpec;
  guardrails?: ProfileGuardrailsSpec;
  observability?: ProfileObservabilitySpec;
  /** This profile's wording: replaces any lexicon default, and any `overrideLexicon` entry, for this profile. */
  lexicon?: LexiconOverrides;
}

/** Any JSON value; the state a decision reads. */
export type DecisionJson =
  | null
  | string
  | number
  | boolean
  | DecisionJson[]
  | { [key: string]: DecisionJson };

/** A decision model binding follows the same protocol/provider/apiId spine as turn models. */
export interface DecisionModelBinding extends Pick<ModelBinding, 'apiId' | 'key'> {
  protocol: 'decision';
  provider: 'typesafe' | 'openrouter';
  timeoutMs?: number;
}

/** What a decision profile accepts: JSON state up to a byte cap. */
export interface DecisionInputsSpec {
  state: 'json';
  maxStateBytes?: number;
}

/**
 * A host-owned id for the decision a profile makes. The trace records it as
 * `theorem.decision.contract`; it is not sent to the provider and does not constrain
 * the questions a call asks.
 */
export type DecisionContractId = string;

/** Decision profile. It cannot be passed to chat or live execution doors. */
export interface DecisionProfile {
  type: 'decision';
  id: ProfileId;
  identity: Pick<ProfileIdentity, 'handle'>;
  /** Exactly one model: a decision profile runs one model and never selects. */
  models: Record<ModelId, DecisionModelBinding>;
  key?: KeySlot;
  inputs: DecisionInputsSpec;
  decision: { contract: DecisionContractId };
  guardrails?: DecisionGuardrailsSpec;
  observability?: ProfileObservabilitySpec;
  /** This profile's wording: replaces any lexicon default, and any `overrideLexicon` entry, for this profile. */
  lexicon?: LexiconOverrides;
}

/** Text or nested text instruction entries. Non-text leaves are rejected locally. */
export type DecisionEntry = string | DecisionEntry[] | { [key: string]: DecisionEntry };

/** A question answered by picking one of the named criteria. */
export interface DecisionChoiceQuestion {
  type: 'choice';
  instructions: DecisionEntry;
  criteria: Record<string, DecisionEntry>;
}

/** A question answered with a single number, optionally with named criteria. */
export interface DecisionNoulQuestion {
  type: 'noul';
  instructions: DecisionEntry;
  criteria?: Record<string, DecisionEntry>;
}

/** A question answered by scoring against an ordered list of criteria. */
export interface DecisionScoreQuestion {
  type: 'score';
  instructions: DecisionEntry;
  criteria: readonly DecisionEntry[];
}

/** One question a decision answers. */
export type DecisionQuestion =
  | DecisionChoiceQuestion
  | DecisionNoulQuestion
  | DecisionScoreQuestion;

/** A request to `runDecision`: the profile, the state to judge and the questions to answer. */
export interface DecisionRequest {
  profile: ProfileId;
  state: Exclude<DecisionJson, null>;
  questions: Record<string, DecisionQuestion>;
  signal?: AbortSignal;
  /** Host-owned metadata preserved on the decision's trace record; the kernel does not interpret it. */
  metadata?: Record<string, unknown>;
  /**
   * W3C `traceparent` of the host span this decision runs under. The `decide`
   * root joins that trace as its child; without it the decision starts a new
   * trace. A malformed value throws.
   */
  traceparent?: string;
}

/** The model's answer to one decision question. */
export type DecisionAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number }
  | {
      type: 'score';
      score: number;
      confidence: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
    };

/** What `runDecision` returns: the model and an answer for each question. */
export interface DecisionResult {
  model: string;
  answers: Record<string, DecisionAnswer>;
  /** Provider-reported tokens and cost, or a provider adapter's known model tariff. */
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
}

/** A profile that runs text turns. */
export interface TextProfile extends ProfileCommon {
  type: 'text';
  tools: ProfileToolsSpec;
  inputs: ProfileInputsSpec;
  turnBehaviour?: ProfileTurnBehaviourSpec;
}

/**
 * An image profile's inputs: no voice channel, and attachments within
 * `IMAGE_ATTACHMENT_ACCEPT`. Every attachment is a reference the model reads;
 * `maxFiles` caps them.
 */
export type ImageInputsSpec = Omit<ProfileInputsSpec, 'voice'>;

/** A profile that generates images. */
export interface ImageProfile extends ProfileCommon {
  type: 'image';
  image: ProfileImageSpec;
  tools: ProfileToolsSpec;
  inputs: ImageInputsSpec;
  turnBehaviour?: MediaTurnBehaviourSpec;
}

/**
 * Unary TTS — text-in locked by type; no tools / inputs block. The input text is the transcript;
 * there is no system prompt, so no canary is planted and nothing of the profile's own can leak.
 */
export interface SpeechProfile extends Omit<ProfileCommon, 'identity'> {
  type: 'speech';
  identity: Pick<ProfileIdentity, 'handle'>;
  speech: ProfileSpeechSpec;
  turnBehaviour?: MediaTurnBehaviourSpec;
}

/** A profile that holds a live audio session. */
export interface LiveProfile extends Omit<ProfileCommon, 'outputs'> {
  type: 'live';
  live: ProfileLiveSpec;
  inputs?: LiveInputsSpec;
  tools: LiveProfileToolsSpec;
  /** Stage inject gate only; live resumption is `live.sessionResumption`. */
  turnBehaviour?: Pick<ProfileTurnBehaviourSpec, 'allowSteering'>;
}

/**
 * Host-driven tool execution; never runs a model. `invokeTool` runs any tool in
 * `tools.allow` with no visibility, loading tiers or path gating. `guardrails` holds only
 * the guards that fire on `invokeTool`: quota, canary and egress guard a model turn, so
 * `defineProfile` refuses them rather than accept inert config.
 */
export interface HostProfile {
  type: 'host';
  id: ProfileId;
  tools: HostProfileToolsSpec;
  guardrails?: HostGuardrailsSpec;
  observability?: ProfileObservabilitySpec;
  /** This profile's wording: replaces any lexicon default, and any `overrideLexicon` entry, for this profile. */
  lexicon?: LexiconOverrides;
}

/** Any profile, discriminated by `type`. */
export type Profile =
  | TextProfile
  | ImageProfile
  | SpeechProfile
  | LiveProfile
  | DecisionProfile
  | HostProfile;

/** Profiles that run a model turn — every type except `host` and `decision` (which runs through `runDecision`). */
export type ModelProfile = Exclude<Profile, HostProfile | DecisionProfile>;

/** The image a profile asks the model to return. */
export interface ImageResponseFormat {
  type: 'image';
  mimeType?: string;
  aspectRatio?: string;
  /** Adapters map it to the provider wire key (Google `imageSize`, OpenRouter `resolution`). */
  resolution?: string;
  quality?: string;
  background?: string;
  n?: number;
  seed?: number;
  outputCompression?: number;
  includeText: boolean;
}

/** A file sent inline with a turn. */
export interface TurnBlob {
  mimeType: string;
  data: string;
  /** The file's name, used only to tell the user which file was refused; never sent to the model. */
  name?: string;
}

/**
 * Media attachment supplied by reference (provider file uri) instead of bytes.
 * MIME acceptance still applies; base64 and byte limits do not.
 */
export interface TurnMediaRef {
  mimeType: string;
  uri: string;
  /** The file's name, used only to tell the user which file was refused; never sent to the model. */
  name?: string;
}

/** A rejected output and the guidance to retry it with. */
export interface TurnRepairRequest {
  previousOutput: string;
  rejection: string;
  guidance?: string;
}

/** What the user sent for a turn: text, slots, attachments, voice and history. */
export interface TurnInput {
  text?: string;
  role?: string;
  slots?: Record<string, string>;
  /** What the page or the host wants the model to know, by sender; the profile's `inputs.context` allows it. */
  context?: TurnContext;
  attachments?: Array<TurnBlob | TurnMediaRef>;
  voice?: TurnBlob[];
  history?: TurnHistoryMessage[];
  repair?: TurnRepairRequest;
  /**
   * Optional host-supplied history token count for `meter: 'history'`.
   * When set, overrides the local history estimate. Not full-prompt API tokens.
   */
  historyTokens?: number;
  /**
   * Optional host-supplied full-prompt input token count for `meter: 'input'`
   * with `timing: 'before'` (typically the previous turn's `tokens.input`).
   * Ignored when `meter` is `'history'`.
   */
  inputTokens?: number;
  sessionResumptionHandle?: string;
}

/** A turn request whose `input` is always present. */
export type NormalizedTurnRequest = TurnRequest & { input: TurnInput };

/**
 * An earlier trace this one follows from. Recorded as a span link on the
 * root, so a developer can walk a conversation across records.
 */
export interface TurnTraceLink {
  /** The earlier root's `traceparent` (its terminal `done.traceparent`). */
  traceparent: string;
  /** `resume` after a pause, `continue` after a resumeable stop, `retry` of a failed turn. */
  kind: 'resume' | 'continue' | 'retry';
  /** How the earlier turn stopped, when the host knows. */
  stop?: TurnStopKind;
}

/** A request to `runTurn`: the profile, the input and the host's hooks and keys. */
export interface TurnRequest {
  profile: ProfileId;
  projectId?: string;
  /**
   * Sticky routing / cache session key for OpenRouter (`session_id`).
   * Not the same as `projectId` or Gemini `previousInteractionId`.
   */
  sessionId?: string;
  /** Google Interactions server-side conversation state. Omit for stateless/manual history. */
  previousInteractionId?: string;
  /**
   * Location bias for Interactions `google_maps` builtin.
   * Wired as `tools: [{ type: "google_maps", latitude, longitude }]`.
   * Ignored when `googleMaps` is not enabled for the selected model.
   */
  googleMapsLocation?: { latitude: number; longitude: number };
  /** Optional Interactions storage override. Omit to let the selected model binding decide. */
  store?: boolean;
  /** Selected model id when `profile.allowModelSelect` is true. */
  model?: ModelId;
  /** Selected effort alias when the binding has `allowEffortSelect`. */
  effort?: string;
  /** Host-provided dynamic system prompt combined with profile persona */
  system?: SystemPrompt;
  /** This turn's voice, style and speed, over `profile.speech`. Speech profiles only. */
  speech?: TurnSpeech;
  sessionPermissions?: string[];
  /** Host channel/path for catalog `paths` filtering. */
  path?: string;
  /** Host-owned metadata preserved for traces; the kernel does not interpret it. */
  metadata?: Record<string, unknown>;
  /**
   * W3C `traceparent` of the host span this turn runs under. The turn's root
   * span joins that trace as its child; without it the turn starts a new trace.
   * A malformed value throws.
   */
  traceparent?: string;
  /** Host conversation id, recorded as `gen_ai.conversation.id`. */
  conversationId?: string;
  links?: TurnTraceLink[];
  /**
   * Opaque application context handed to tool `handler` / `preTool` and
   * `tools.t1Policy` as `ctx.host`. The kernel never reads, logs, traces, or
   * serializes it.
   */
  host?: unknown;
  /**
   * Optional abort signal. When aborted, THEOREM stops the turn and cancels
   * in-flight provider HTTP where the adapter supports it.
   */
  signal?: AbortSignal;
  /**
   * Continue a prior resumeable stop. On text profiles the turn's user message
   * is the continue instruction (no `input.text`); the host passes the partial
   * reply as the last assistant message in `input.history`. Image and speech
   * re-send the original request unchanged.
   */
  continueFrom?: TurnContinueFrom;
  /**
   * 1-based continue attempt when `continueFrom` is set.
   * Compared to `profile.turnBehaviour.resumption.maxContinues` when that cap is set.
   */
  continuation?: number;
  input?: TurnInput;
  /** Runs a `timing: 'before'` compactor the turn's provider cannot. */
  compactionProvider?: ModelProvider;
  sessionResumptionHandle?: string;
  /** Credentials for authenticated HTTP / MCP tools, read by auth slot when a tool needs one. */
  credentials?: ToolCredentialSource;
  /**
   * Resolves remote tool and OAuth host names before each request; a name that
   * resolves to a private address is refused (see `fetchGuarded`).
   */
  resolveHost?: ResolveHost;
  /** Text `runTurn` emits stages and applies the returned affordances. */
  onStage?: StageHandler;
  /**
   * Runs before each agent tool call in this turn, and in the turns those
   * calls run. Shape the called agent's request (history, model, provider) or
   * refuse the call. Omit it: the agent runs on the model's text alone.
   */
  onAgentCall?: AgentCallHook;
}

/** A profile projected for a client, with its secrets and server-only fields removed. */
export interface ProjectedProfile extends ProfileModelFields {
  id: string;
  type: ModelProfile['type'];
  handle: string;
  tools: Array<RegisteredTool | { name: ToolId; missing: true }>;
  inputs: ProfileInputsSpec | null;
  outputs: ProfileOutputsSpec | null;
  image?: ProfileImageSpec | null;
  speech?: ProfileSpeechSpec | null;
  live?: ProfileLiveSpec | null;
}

/** The generation settings a provider call is made with. */
export interface ProviderGenerationConfig {
  model: ModelId;
  apiId: string;
  previousInteractionId?: string;
  store?: boolean;
  /**
   * Upstream stream vs batch, derived from `outputs.streaming.mode`.
   * `true` = SSE (THEOREM default when mode is omitted); `false` = buffered.
   */
  stream?: boolean;
  thinking?: ThinkingLevel;
  summaries?: SummaryMode;
  maxOutputTokens?: number;
  temperature?: number;
  builtins: BuiltinToolId[];
  googleMapsLocation?: { latitude: number; longitude: number };
  /** OpenRouter only. */
  cache?: CacheSpec;
  /** Forwarded as OpenRouter `session_id`. */
  sessionId?: string;
}

/** The transport a provider adapter speaks. */
export type ProviderTransport = 'interactions' | 'geminiLive' | 'openAiCompat';

/** A generation config after the profile and request are resolved, with its transport. */
export interface ResolvedGeneration extends ProviderGenerationConfig {
  transport: ProviderTransport;
  /**
   * Whether the turn's steps chain on the stored interaction: a tool result or
   * stage inject rides `continuation` after `previousInteractionId`. Only an
   * Interactions binding chains, and never one with `persistViaInteractionId:
   * false` — its steps each send the host's history plus the turn's steps so far.
   */
  chains: boolean;
  tools: TurnToolSnapshot;
  sessionPermissions?: string[];
  history?: TurnHistoryMessage[];
  /**
   * Interactions-only: messages sent after `previousInteractionId` (tool
   * results, stage injects) instead of history + user parts. The model reads
   * the stored interaction plus these.
   */
  continuation?: TurnHistoryMessage[];
  /** Tool-loop ceiling: the profile's `maxSteps`, or `DEFAULT_MAX_STEPS`. */
  maxSteps?: number;
  structured: ResolvedStructured | null;
  image: ImageResponseFormat | null;
  speech?: ProfileSpeechSpec;
  live?: ProfileLiveSpec;
  input: InteractionPart[];
  /**
   * Vault key slot; every model but a local one without a key names one. Never sent on the wire.
   */
  keySlot?: KeySlot;
  /** The slot a quota refusal on `keySlot` retries on once, when the profile names one. */
  fallbackKeySlot?: KeySlot;
  /**
   * The canary bound into the system prompt; empty with the canary off. A turn
   * binds the profile's (`profileCanary`), the same for the same prompt; a
   * Live session binds this one, minted for it.
   */
  canary: string;
  sessionResumptionHandle?: string;
  /** Snapshotted synchronously before any async work; the runner binds the canary on top. */
  resolvedSystem: readonly SystemPiece[];
  /** `TurnRequest.host`, carried to tool contexts only. Never sent to providers or traces. */
  host?: unknown;
}

/**
 * `previousInteractionId`, `store`, `stream`, `summaries` and `continuation` are
 * Google Interactions-only and absent otherwise. `keySlot` is required for every
 * provider but local; it is never sent on the wire.
 */
export interface ProviderCompleteRequest
  extends Omit<ProviderGenerationConfig, 'summaries' | 'builtins'> {
  /** The turn's builtins with their wire names; adapters read no registry. */
  builtins: ProviderBuiltin[];
  summaries?: SummaryMode;
  system: string;
  input: InteractionPart[];
  history?: TurnHistoryMessage[];
  /** Sent after `previousInteractionId` instead of history + user parts; mapped like history. */
  continuation?: TurnHistoryMessage[];
  wireTools?: WireFunctionTool[];
  structured: ResolvedStructured | null;
  image: ImageResponseFormat | null;
  speech?: ProfileSpeechSpec;
  live?: ProfileLiveSpec;
  sessionResumptionHandle?: string;
  keySlot?: KeySlot;
  /** The slot a quota refusal on `keySlot` retries on once. Never sent on the wire. */
  fallbackKeySlot?: KeySlot;
  /** Scrubbed SSE / HTTP rows for traces. */
  tapUpstream?: (row: Record<string, unknown>) => void;
  /** Host abort signal — adapters should pass this into fetch / SDK calls. */
  signal?: AbortSignal;
}

/** A provider adapter: one `complete` call that streams the model's events. */
export interface ModelProvider {
  complete: (req: ProviderCompleteRequest) => AsyncIterable<ProviderEvent>;
}

/**
 * Host request to open a long-lived live session (`runSession`).
 * Profile must be `type: 'live'`.
 */
export interface SessionRequest {
  profile: ProfileId;
  /** Host-built system prompt merged with profile identity.system. */
  system?: SystemPrompt;
  /** Override `profile.live.voice` for this session. */
  voice?: string;
  path?: string;
  sessionPermissions?: string[];
  history?: TurnHistoryMessage[];
  sessionResumptionHandle?: string;
  /** The value chosen for each of the profile's `inputs.slots`. */
  slots?: Record<string, string>;
  /** What the page and the host tell the agent as the call opens; `sendContext` replaces it later. */
  context?: TurnContext;
  /** How long the caller was away before this resume, in milliseconds. The session keeps no clock across calls. */
  awayMs?: number;
  /** Optional realtime parts sent immediately after setup. A call that sends them gets no `live.greeting`. */
  input?: InteractionPart[];
  /**
   * Registry-resolved tool snapshot from the process that owns the tool registry
   * (`prepareTurnToolSnapshot`). When set, session setup declares `snapshot.wire`
   * instead of resolving tools locally, so a relay process without the registry
   * can open the session. Every custom id must be within the profile's
   * `tools.allow`; ids outside it are refused.
   */
  snapshot?: TurnToolSnapshot;
  signal?: AbortSignal;
  /** Host-owned metadata preserved on every record the session writes. */
  metadata?: Record<string, unknown>;
  /**
   * W3C `traceparent` of the host span this session runs under. The session's
   * root span joins that trace as its child; without it the session starts a
   * new trace. A malformed value throws.
   */
  traceparent?: string;
  /** Host conversation id, recorded as `gen_ai.conversation.id`. */
  conversationId?: string;
  links?: TurnTraceLink[];
  /** Immutable for the session; there is no `setOnStage`. */
  onStage?: StageHandler;
  /**
   * Default credentials for `executeTool` (per-call args override). Without one, the
   * session keeps keys typed at its sign-in gates in memory.
   */
  credentials?: ToolCredentialSource;
  /**
   * Resolves remote tool and OAuth host names before each request; a name that
   * resolves to a private address is refused (see `fetchGuarded`).
   */
  resolveHost?: ResolveHost;
  /** Opaque host slot for stages / tool execute (per-call args override). */
  host?: unknown;
}

/**
 * Run a call the model made in this session, by its id: once, with the
 * model's input. `decision` answers a call waiting on a gate, and only such a
 * call; `input` is the user's edit, and only with `approve` on a gated call.
 */
export type LiveExecuteToolArgs = {
  callId: string;
  decision?: GateDecision;
  input?: unknown;
  /**
   * The key the user typed at a sign-in gate, only with `approve` on that
   * gate: the session sets it as the credential for the gate's slot
   * (`credentialFromTypedSecret`) in the source the call runs with.
   */
  secret?: string;
  credentials?: ToolCredentialSource;
  host?: unknown;
  /** The page's answer, for a call to a tool with `answeredBy: 'page'`. */
  page?: PageAnswer;
};

/**
 * Settle a call the model made in this session whose body ran in the process
 * that owns the tool registry: `events` are that process's `invokeTool`
 * events for `callId`, which ran with the model's input.
 */
export type LiveAnswerToolCallArgs = {
  callId: string;
  events: readonly TurnEvent[];
};

/** What running a tool call during a live session returns. */
export type LiveExecuteToolResult = {
  outputRaw?: unknown;
  outputModel?: ModelToolResult;
  failure?: ToolFailure;
  awaiting?: boolean;
  gated?: ToolGate;
};

/**
 * Open Gemini Live session returned by `runSession`. It streams events until
 * `close()` and exposes realtime media ingress and staged tool execution.
 */
export interface LiveSession {
  readonly profileId: ProfileId;
  readonly canary: string;
  events(): AsyncGenerator<TurnEvent, void, undefined>;
  /** `mimeType` states the audio as sent (`audio/pcm;rate=16000`); the API rejects what it cannot take. */
  sendAudio(args: { data: string; mimeType: string }): Promise<void>;
  /** `mimeType` states the frame as sent (`image/jpeg`). */
  sendVideo(args: { data: string; mimeType: string }): Promise<void>;
  sendText(text: string): Promise<void>;
  /**
   * What the page or the host tells the model to know, by sender: it opens no turn and
   * draws no reply. Checked against `inputs.context` and read at the `context` boundary;
   * the model sees it from its next turn on.
   */
  sendContext(context: TurnContext): Promise<void>;
  /**
   * Run a call the model made through the registry, with stages; its events
   * join `events()`. A gate returns `gated` and answers the model nothing yet;
   * the call waits `gateTtlMs` for its `decision`. An unknown, settled,
   * running or expired call is a `request` error and runs nothing.
   */
  executeTool(args: LiveExecuteToolArgs): Promise<LiveExecuteToolResult>;
  /**
   * Settle a call whose body ran in the registry-owning process: its events
   * join `events()` and the model reads its `readBack`. A run that ends on a
   * gate leaves the call open; a released sign-in (`signInGate: 'answer'`)
   * takes its outcome until `gateTtlMs`. An unknown, settled, running or
   * expired call, or events that settle nothing for it, is a `request` error.
   */
  answerToolCall(args: LiveAnswerToolCallArgs): LiveExecuteToolResult;
  close(reason?: string): Promise<void>;
}
