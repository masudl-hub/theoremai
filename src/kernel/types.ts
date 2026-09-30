import type {
  CacheMode,
  CacheTtl,
  CompactionMeter,
  CompactionOutcome,
  CompactionTiming,
  ContinueStopKind,
  FieldMeta,
  KeySlot,
  KeyVault,
  LiveActivityHandling,
  LiveEndSensitivity,
  LiveStartSensitivity,
  MediaInputKind,
  OverflowKeySlot,
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
  BuiltinWire,
  HostProfileToolsSpec,
  InvokeToolRequest,
  InvokeToolResume,
  LiveProfileToolsSpec,
  ModelToolResult,
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
  OverflowKeySlot,
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

export type ModelId = string;

export type BuiltinToolId = string;
export type ToolId = string;

export type StructuredSchemaId = string;

export interface ResolvedStructured {
  id: StructuredSchemaId;
  jsonSchema: Record<string, unknown>;
}

export interface ProviderBuiltin {
  id: BuiltinToolId;
  wire: BuiltinWire;
}

export type ProfileId = string;

export type ChatRole = 'system' | 'user' | 'assistant';

/** Host strings (presets own the vocabularies); an unpinned value is the provider default. */
export interface ProfileImageSpec {
  aspectRatio?: string;
  size?: string;
  mimeType?: string;
  /** Also request interleaved text with the images (Google: text + image `response_format`). */
  includeText?: boolean;
}

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
  /** Overrides `profile.key` for this model (e.g. pin image models to `paid`). */
  key?: KeySlot;
  compaction?: CompactionSpec;
  /**
   * OpenRouter prompt-cache policy. Omit → no opt-in `cache_control`.
   * `defineProfile` accepts only when `provider` is `openrouter` (protocol `openAi`).
   */
  cache?: CacheSpec;
  /** Gemini Interactions: whether the provider stores the interaction. Omit → provider default. */
  store?: boolean;
  /**
   * Gemini Interactions: prefer server-side thread via `previous_interaction_id`
   * instead of client-owned history. Omit → host/turn decides.
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

export interface CompactionTriggerContext {
  tokens: number;
  maxTokens: number;
  compactAt: number;
  meter: CompactionMeter;
  /** Media parts not counted in `tokens` — no verified rule for this model. */
  unknownMedia: number;
}

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
  /** Profile id of the compaction agent. Must be registered before the owning profile. */
  profile: ProfileId;
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

export interface StructuredSpec {
  jsonSchema: Record<string, unknown>;
}

export interface MediaLimits {
  maxFiles: number;
  maxBytes: number;
  maxTurnBytes: number;
  limitsByMime?: Record<string, number>;
}

export interface MimeInputs extends Partial<MediaLimits> {
  text?: boolean;
  attachments?: { accept: string[] };
  voice?: { accept: string[] };
}

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

export interface StructuredBySlot {
  by: string;
  map: Record<string, string>;
  fallback: string;
}

export interface ValidationResult {
  isValid: boolean;
  error?: string;
  finding?: string;
  data?: Record<string, unknown>;
}

export type ProfileValidator = (
  candidate: unknown,
  slots?: Record<string, string>,
) => ValidationResult | Promise<ValidationResult>;

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
  /** `mp3` requires `protocol: 'openAi'` speech; rejected on Interactions. */
  format?: SpeechAudioFormat;
}

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

export interface LiveSlidingWindowSpec {
  /**
   * Tokens to keep after compressing. A whole number above 0, below
   * `triggerTokens`. Omit → provider default (Gemini: half of `triggerTokens`).
   */
  targetTokens?: number;
}

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

export interface ProfileLiveSpec {
  ingress?: LiveIngressSpec;
  voice?: string;
  vad?: LiveVadSpec;
  sessionResumption?: boolean;
  /** Context window compression. Omit → none: the provider ends the session at its limit. */
  contextCompression?: LiveContextCompressionSpec;
  /** Proactivity: allow model to stay silent or ignore irrelevant input. */
  proactiveAudio?: boolean;
  transcription?: LiveTranscriptionSpec;
}

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
import type { ToolCredential } from './auth/types.ts';
import type { MediaTurnBehaviourSpec, ProfileTurnBehaviourSpec, TurnContinueFrom } from './stop.ts';

export interface ProfileModelFields {
  /** Host-named models. Each key is a selectable model id when `allowModelSelect` is set. */
  models: Record<ModelId, ModelBinding>;
  /** The model a turn runs when it names none; registration fills it with the only key when there is one. */
  defaultModel: ModelId;
  /** Turn may pass `{ model: "<id>" }`. Requires two or more `models` keys. */
  allowModelSelect?: boolean;
  /** Tool-loop ceiling. Omit or `<= 0` = unbounded; `1` = one-shot; `> 1` = hard cap. */
  maxSteps?: number;
  key?: OverflowKeySlot;
}

export interface ProfileInputsSpec {
  text?: boolean;
  attachments?: { accept: string[] };
  voice?: { accept: string[] };
  maxFiles?: number;
  maxBytes?: number;
  maxTurnBytes?: number;
  limitsByMime?: Record<string, number>;
  slots?: Record<string, string[]>;
}

export interface ProfileOutputsSpec {
  structured?: StructuredSchemaId | StructuredBySlot | null;
  validation?: ProfileValidationSpec;
  streaming?: ProfileStreamingSpec;
}

export interface ProfileIdentity {
  handle: string;
  system?: string;
  systemByRole?: Record<string, string>;
}

export interface ProfileCommon {
  id: ProfileId;
  identity: ProfileIdentity;
  models: Record<ModelId, ModelBinding>;
  defaultModel: ModelId;
  allowModelSelect?: boolean;
  maxSteps?: number;
  key?: OverflowKeySlot;
  outputs?: ProfileOutputsSpec;
  guardrails?: ProfileGuardrailsSpec;
  observability?: ProfileObservabilitySpec;
  /** This profile's wording: replaces any lexicon default, and any `overrideLexicon` entry, for this profile. */
  lexicon?: LexiconOverrides;
}

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

export interface DecisionChoiceQuestion {
  type: 'choice';
  instructions: DecisionEntry;
  criteria: Record<string, DecisionEntry>;
}

export interface DecisionNoulQuestion {
  type: 'noul';
  instructions: DecisionEntry;
  criteria?: Record<string, DecisionEntry>;
}

export interface DecisionScoreQuestion {
  type: 'score';
  instructions: DecisionEntry;
  criteria: readonly DecisionEntry[];
}

export type DecisionQuestion =
  | DecisionChoiceQuestion
  | DecisionNoulQuestion
  | DecisionScoreQuestion;

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

export interface DecisionResult {
  model: string;
  answers: Record<string, DecisionAnswer>;
  /** Provider-reported tokens and cost, or a provider adapter's known model tariff. */
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
}

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

export interface ImageProfile extends ProfileCommon {
  type: 'image';
  image: ProfileImageSpec;
  tools: ProfileToolsSpec;
  inputs: ImageInputsSpec;
  turnBehaviour?: MediaTurnBehaviourSpec;
}

/**
 * Speech guardrails: no canary. A speech turn has no system channel to bind a
 * token into (Gemini TTS rejects developer instructions) and yields audio, not
 * text a canary scan could read.
 */
export type SpeechGuardrailsSpec = Omit<ProfileGuardrailsSpec, 'canary'> & { canary?: false };

/** Unary TTS — text-in locked by type; no tools / inputs block. The input text is the transcript; there is no system prompt. */
export interface SpeechProfile extends Omit<ProfileCommon, 'identity' | 'guardrails'> {
  type: 'speech';
  identity: Pick<ProfileIdentity, 'handle'>;
  /** Registration always stores `canary: false`. */
  guardrails: SpeechGuardrailsSpec & { canary: false };
  speech: ProfileSpeechSpec;
  turnBehaviour?: MediaTurnBehaviourSpec;
}

export interface LiveProfile extends Omit<ProfileCommon, 'outputs'> {
  type: 'live';
  live: ProfileLiveSpec;
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

export type Profile =
  | TextProfile
  | ImageProfile
  | SpeechProfile
  | LiveProfile
  | DecisionProfile
  | HostProfile;

/** Profiles that run a model turn — every type except `host` and `decision` (which runs through `runDecision`). */
export type ModelProfile = Exclude<Profile, HostProfile | DecisionProfile>;

export interface ImageResponseFormat {
  type: 'image';
  mimeType?: string;
  aspectRatio?: string;
  /** Adapters map it to the provider wire key (e.g. Google `imageSize`). */
  size?: string;
  includeText: boolean;
}

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

export interface TurnRepairRequest {
  previousOutput: string;
  rejection: string;
  guidance?: string;
}

export interface TurnInput {
  text?: string;
  role?: string;
  slots?: Record<string, string>;
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
  system?: string;
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
  /**
   * Host credentials for authenticated HTTP / MCP tools keyed by auth slot. A refreshed
   * OAuth credential replaces its slot in this record; persist it when the turn emits
   * `auth_token_refreshed` for that slot.
   */
  credentials?: Record<string, ToolCredential>;
  /**
   * Resolves remote tool and OAuth host names before each request; a name that
   * resolves to a private address is refused (see `fetchGuarded`).
   */
  resolveHost?: ResolveHost;
  /** Text `runTurn` emits stages and applies the returned affordances. */
  onStage?: StageHandler;
}

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

export type ProviderTransport = 'interactions' | 'geminiLive' | 'openAiCompat';

export interface ResolvedGeneration extends ProviderGenerationConfig {
  transport: ProviderTransport;
  /**
   * Whether the turn's steps chain on the stored interaction: a tool result or
   * stage inject rides `continuation` after `previousInteractionId`. Only an
   * Interactions binding chains, and never one with `persistViaInteractionId:
   * false` — its steps each send the full history.
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
  /** Tool-loop ceiling. `undefined` or `<= 0` = unbounded. */
  maxSteps?: number;
  structured: ResolvedStructured | null;
  image: ImageResponseFormat | null;
  speech?: ProfileSpeechSpec;
  live?: ProfileLiveSpec;
  input: InteractionPart[];
  /**
   * Vault key slot for credentialed transports (Google required; OpenRouter when
   * the profile pins `key` or a builtin forces `paid`). Never sent on the wire.
   */
  keySlot?: KeySlot;
  canary: string;
  sessionResumptionHandle?: string;
  /** Snapshotted synchronously before any async work; the runner binds the canary on top. */
  resolvedSystem: string;
  /** `TurnRequest.host`, carried to tool contexts only. Never sent to providers or traces. */
  host?: unknown;
}

/**
 * `previousInteractionId`, `store`, `stream`, `summaries` and `continuation` are
 * Google Interactions-only and absent otherwise. `keySlot` is required for Google and
 * optional for OpenRouter; it is never sent on the wire.
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
  /** Scrubbed SSE / HTTP rows for traces. */
  tapUpstream?: (row: Record<string, unknown>) => void;
  /** Host abort signal — adapters should pass this into fetch / SDK calls. */
  signal?: AbortSignal;
}

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
  system?: string;
  /** Override `profile.live.voice` for this session. */
  voice?: string;
  path?: string;
  sessionPermissions?: string[];
  history?: TurnHistoryMessage[];
  sessionResumptionHandle?: string;
  /** Optional realtime parts sent immediately after setup. */
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
   * Default credentials for `executeTool` (per-call args override). A refreshed OAuth
   * credential replaces its slot in the record the call used.
   */
  credentials?: Record<string, ToolCredential>;
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
   * gate: the session makes it the credential for the gate's slot
   * (`credentialFromTypedSecret`) and keeps it for the rest of the session.
   */
  secret?: string;
  credentials?: Record<string, ToolCredential>;
  host?: unknown;
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
   * Run a call the model made through the registry, with stages; its events
   * join `events()`. A gate returns `gated` and answers the model nothing yet;
   * the call waits `gateTtlMs` for its `decision`. An unknown, settled,
   * running or expired call is a `request` error and runs nothing.
   */
  executeTool(args: LiveExecuteToolArgs): Promise<LiveExecuteToolResult>;
  /**
   * Settle a call whose body ran in the registry-owning process: its events
   * join `events()` and the model reads its `readBack`. A run that ends on a
   * gate leaves the call open. An unknown, settled or running call, or events
   * that settle nothing for it, is a `request` error.
   */
  answerToolCall(args: LiveAnswerToolCallArgs): LiveExecuteToolResult;
  close(reason?: string): Promise<void>;
}
