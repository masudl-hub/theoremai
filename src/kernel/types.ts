/**
 * Shared type contracts for THEOREM profiles, turns, provider adapters, tools,
 * guardrails, and stream events.
 *
 * Import from `@theoremai/agents/kernel` or `jsr:@theoremai/agents/kernel` when a host app needs types without
 * importing provider implementations.
 *
 * @module
 */

import type {
  CacheMode,
  CacheTtl,
  CompactionMeter,
  CompactionTiming,
  ContinueStopKind,
  FieldMeta,
  KeySlot,
  KeyVault,
  LiveActivityHandling,
  LiveSpeechSensitivity,
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
import type { StageApplyWarning, StageHandler } from './stages.ts';
import type {
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

export type {
  CacheMode,
  CacheTtl,
  CompactionMeter,
  CompactionTiming,
  ContinueStopKind,
  FieldMeta,
  HostProfileToolsSpec,
  InvokeToolRequest,
  KeySlot,
  KeyVault,
  LiveActivityHandling,
  LiveProfileToolsSpec,
  LiveSpeechSensitivity,
  MediaInputKind,
  OverflowKeySlot,
  ProfileToolsSpec,
  ProfileType,
  ProfileTypeProtocol,
  Protocol,
  Provider,
  RegisteredTool,
  SpeechAudioFormat,
  StreamMode,
  SummaryMode,
  ThinkingLevel,
  ToolCallEvent,
  ToolGate,
  ToolLoadContext,
  ToolLoadTier,
  ToolPolicy,
  TurnStage,
  TurnStopKind,
  TurnToolSnapshot,
  WireFunctionTool,
};

/** Any host-declared model id. */
export type ModelId = string;

/** Provider-projected builtin tool id (registered by presets/adapters). */
export type BuiltinToolId = string;
/** Any tool id accepted by profile allowlists and per-turn gates. */
export type ToolId = string;

/** Id of a host-registered structured output schema. */
export type StructuredSchemaId = string;

/** Host-owned profile identifier. */
export type ProfileId = string;

/** Message role accepted by provider history mappers. */
export type ChatRole = 'system' | 'user' | 'assistant';

/**
 * Image-role output pins owned by the host profile.
 * The image model itself lives in `profile.models`.
 * Aspect/size/mime values are host strings (presets/apps own the vocabularies).
 */
export interface ProfileImageSpec {
  /** Optional output aspect ratio pin (provider default when omitted). */
  aspectRatio?: string;
  /** Optional output size / resolution pin (provider default when omitted). */
  size?: string;
  /** Output MIME for generated images. */
  mimeType?: string;
  /** Cap on reference images in one turn. */
  maxInputImages?: number;
  /**
   * When true, request interleaved assistant text alongside generated images
   * (Google: `response_format` array with text + image entries).
   */
  includeText?: boolean;
}

/** Public event types emitted by `runTurn` and provider adapters. */
export type TurnEventType =
  | 'thought'
  | 'text'
  | 'tool'
  | 'structured'
  | 'media'
  | 'grounding'
  | 'evidence'
  | 'tokens'
  /** Provider → runner only: the response's identity, recorded on the call's trace; `runTurn` never yields it. */
  | 'response'
  | 'session'
  | 'guardrail'
  | 'stage'
  | 'done'
  | 'error';

/**
 * Live session control signals (provider-neutral).
 *
 * - `turn_complete` — one spoken response ended; the server may still be working.
 * - `working` — server is reasoning or awaiting async tool results; more output may follow.
 * - `idle` — server finished all processing; conversational cycle boundary.
 * - `ended` — the provider ended the session after warning it would
 *   (`closing_soon`); the last event of the session, not a failure.
 */
export type SessionEventKind =
  | 'closing_soon'
  | 'ended'
  | 'waiting_for_input'
  | 'turn_complete'
  | 'working'
  | 'idle';

/** Provider-neutral control signal emitted by a live session. */
export interface SessionEvent {
  kind: SessionEventKind;
  /**
   * Parsed drain window when the provider supplied a duration; omit when unknown.
   * On `ended`, the window the last warning gave.
   */
  timeLeftMs?: number;
  /** On `ended`: how and when the provider closed the session. */
  ended?: SessionEnded;
  /** On `ended`: what the user reads — the profile's `live.session_ended` wording. */
  message?: string;
}

/**
 * A session the provider ended after warning it would. The raw close reason
 * travels as the event's `errorInternal`, for the builder only.
 */
export interface SessionEnded {
  /** The provider warned first (Gemini `goAway`). */
  cause: 'go_away';
  /** The provider's WebSocket close code. */
  code: number;
  /** Milliseconds from the last warning to the close; compare with `timeLeftMs`. */
  closedAfterMs: number;
  /** What the close code means as a failure, when it is not a normal close (1000). */
  errorKind?: ErrorKind;
}

/** Host-named model binding — wire routing and generation knobs for one profile model. */
export interface ModelBinding {
  protocol: Protocol;
  provider: Provider;
  /** Provider wire model id for the configured provider. */
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
  /**
   * Provider-native builtins this model supports.
   * Omit or `[]` when none. Opt in per turn with `tools[id]: true`.
   */
  builtInTools?: BuiltinToolId[];
  /**
   * Optional vault slot for this model. When set, overrides `profile.key`.
   * Host-owned — e.g. pin image models to `paid`.
   */
  key?: KeySlot;
  /** Optional compaction policy for this model's context window (chat profiles). */
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

/**
 * Context supplied to a custom compaction trigger.
 *
 * Includes the resolved token count and the spec values so the trigger can
 * incorporate the token-based threshold as a fallback alongside other signals
 * (e.g. available system RAM).
 */
export interface CompactionTriggerContext {
  /** Resolved token count for the configured meter. */
  tokens: number;
  /** `CompactionSpec.maxTokens` — the token ceiling for this profile. */
  maxTokens: number;
  /** `CompactionSpec.compactAt` — the fraction at which the default check fires. */
  compactAt: number;
  /** Which meter produced `tokens`. */
  meter: CompactionMeter;
  /** Media parts not counted in `tokens` — no verified rule for this model. */
  unknownMedia: number;
}

/**
 * Compaction policy for a model.
 *
 * `previousExchanges` accepts three value ranges:
 * - `≥ 1` (integer) — keep that many recent exchanges (user message + all
 *   messages until the next user message).
 * - `(0, 1)` — fraction of `maxTokens`; the retained tail's estimated history
 *   tokens must fit within this budget.
 * - `0` — compact everything; no tail is retained.
 */
export interface CompactionSpec {
  /**
   * Token budget compared by the trigger (`compactAt * maxTokens`).
   * Meaning depends on `meter`: history budget vs full-prompt input budget.
   */
  maxTokens: number;
  /** Fraction of `maxTokens` at which compaction fires. Must be in (0, 1). */
  compactAt: number;
  /**
   * How many recent exchanges to preserve verbatim.
   * `≥ 1` = exchange count, `(0, 1)` = fraction of `maxTokens`, `0` = compact all.
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
  /**
   * Optional custom trigger. When present, replaces the default token-threshold
   * check (`tokens > compactAt * maxTokens`). The trigger receives full context
   * so it can incorporate the token-based logic as a fallback alongside other
   * signals such as available system RAM.
   *
   * Both sync and async returns are accepted.
   */
  trigger?: (ctx: CompactionTriggerContext) => boolean | Promise<boolean>;
}

/** Host-registered structured output: the JSON Schema the model is held to on the wire. */
export interface StructuredSpec {
  jsonSchema: Record<string, unknown>;
}

/** Per-turn file, byte, and MIME-specific input limits. */
export interface MediaLimits {
  maxFiles: number;
  maxBytes: number;
  maxTurnBytes: number;
  limitsByMime?: Record<string, number>;
}

/** Input media declaration used by attachment and voice sanitizers. */
export interface MimeInputs extends Partial<MediaLimits> {
  text?: boolean;
  attachments?: { accept: string[] };
  voice?: { accept: string[] };
}

export type AttachmentValidationCode =
  | 'mime_not_allowed'
  | 'too_many_files'
  | 'too_many_images'
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
  maxImages?: number;
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

/** Structured schema selector driven by an input slot. */
export interface StructuredBySlot {
  by: string;
  map: Record<string, string>;
  fallback: string;
}

/** Result returned by a profile output validator. */
export interface ValidationResult {
  isValid: boolean;
  error?: string;
  finding?: string;
  data?: Record<string, unknown>;
}

/** Host-owned validator for structured output candidates. */
export type ProfileValidator = (
  candidate: unknown,
  slots?: Record<string, string>,
) => ValidationResult | Promise<ValidationResult>;

/** Profile output validation and deterministic repair configuration. */
export interface ProfileValidationSpec {
  /**
   * Host domain validators keyed by dotted paths into structured output
   * (e.g. `diagram.mermaid`). Presence/required is owned by the JSON Schema;
   * these run only for required paths and for optional paths that are present.
   */
  fields?: Record<string, ProfileValidator>;
  maxRetries?: number;
}

/**
 * Speech-role output pins owned by the host profile.
 * The speech model itself lives in `profile.models`.
 * Declared top-level under `speech` so `voice` here is the TTS voice id,
 * not ingress audio (`inputs.voice`).
 */
export interface ProfileSpeechSpec {
  voice?: string;
  /**
   * Output container. `pcm` (default) → WAV media on both transports.
   * `mp3` requires `protocol: 'openAi'` speech; rejected on Interactions.
   */
  format?: SpeechAudioFormat;
}

/** Voice activity detection & barge-in configuration for live bidirectional streaming. */
export interface LiveVadSpec {
  activityHandling?: LiveActivityHandling;
  startSensitivity?: LiveSpeechSensitivity;
  endSensitivity?: LiveSpeechSensitivity;
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

/** Sliding-window compression: the context is cut from the start, down to a target. */
export interface LiveSlidingWindowSpec {
  /**
   * Tokens to keep after compressing. A whole number above 0, below
   * `triggerTokens`. Omit → provider default (Gemini: half of `triggerTokens`).
   */
  targetTokens?: number;
}

/** Audio transcription toggles for live sessions. */
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

/**
 * Output pins for a live-role profile (bidirectional WebSocket audio/video session).
 * The live model itself lives in `profile.models`.
 */
export interface ProfileLiveSpec {
  /** Realtime ingress modality toggles (mic, camera frames, typed text). */
  ingress?: LiveIngressSpec;
  /** Output TTS voice name (e.g. 'Puck', 'Aoede', 'Charon'). */
  voice?: string;
  /** Voice activity detection & barge-in configuration. */
  vad?: LiveVadSpec;
  /** Whether session resumption updates and reconnection handles are enabled. */
  sessionResumption?: boolean;
  /** Context window compression. Omit → none: the provider ends the session at its limit. */
  contextCompression?: LiveContextCompressionSpec;
  /** Proactivity: allow model to stay silent or ignore irrelevant input. */
  proactiveAudio?: boolean;
  /** Real-time input/output audio transcriptions. */
  transcription?: LiveTranscriptionSpec;
}

/** Stream delivery controls enforced by the kernel. */
export interface ProfileStreamingSpec {
  /**
   * Profile-only source of truth for upstream stream vs batch.
   * `sse` → stream; `buffered` → non-SSE where the transport supports it.
   * Omit → THEOREM defaults to SSE (`ResolvedGeneration.stream === true`).
   */
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
import type { ErrorCopy, ErrorKind } from '../guardrails/theorem-error.ts';
import type {
  DecisionGuardrailsSpec,
  GuardrailEvent,
  HostGuardrailsSpec,
  ProfileGuardrailsSpec,
} from '../guardrails/types.ts';
import type { ProfileObservabilitySpec } from '../observability/types.ts';
import type { ToolCredential } from './auth/types.ts';
import type {
  MediaTurnBehaviourSpec,
  ProfileTurnBehaviourSpec,
  TurnContinueFrom,
  TurnStop,
} from './stop.ts';

/** Model routing fields shared by every profile type. */
export interface ProfileModelFields {
  /** Host-named models. Each key is a selectable model id when `allowModelSelect` is set. */
  models: Record<ModelId, ModelBinding>;
  /** The model a turn runs when it names none; registration fills it with the only key when there is one. */
  defaultModel: ModelId;
  /** Turn may pass `{ model: "<id>" }`. Requires two or more `models` keys. */
  allowModelSelect?: boolean;
  /**
   * Tool-loop ceiling. `<= 0` = unbounded; `1` = one-shot; `> 1` = hard cap.
   * Omit → unbounded (no THEOREM invent of `1`).
   */
  maxSteps?: number;
  key?: OverflowKeySlot;
}

/** Text, attachment, voice, slot, and size rules for a profile. */
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

/** Chat-shaped output schema, validation, and stream filters. */
export interface ProfileOutputsSpec {
  structured?: StructuredSchemaId | StructuredBySlot | null;
  validation?: ProfileValidationSpec;
  streaming?: ProfileStreamingSpec;
}

/** Shared identity block for every profile type. */
export interface ProfileIdentity {
  handle: string;
  system?: string;
  systemByRole?: Record<string, string>;
}

/** Fields shared by every typed profile. */
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

/** JSON value accepted as native decision state. Media is a host concern. */
export type DecisionJson =
  | null
  | string
  | number
  | boolean
  | DecisionJson[]
  | { [key: string]: DecisionJson };

/** Native TypeSafe Jev binding; deliberately has no chat protocol/provider pair. */
export interface DecisionModelBinding {
  apiId: string;
  key?: KeySlot;
  timeoutMs?: number;
  retry?: { maxRetries?: number };
}

export interface DecisionInputsSpec {
  state: 'json';
  maxStateBytes?: number;
}

/** A host-owned decision contract identifier. */
export type DecisionContractId = string;

/** Native Jev profile. It cannot be passed to chat or live execution doors. */
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

/** Jev's text-or-structured instruction entries. Null is rejected locally. */
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
  metadata?: Record<string, unknown>;
}

export type DecisionAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number }
  | {
      type: 'score';
      score: number;
      confidence: number;
      legend: Record<string, number>;
      probabilities: Record<string, number>;
    };

export interface DecisionResult {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage?: { inputTokens: number; outputTokens: number };
}

/** Text / structured turn engine with optional tool execution. */
export interface TextProfile extends ProfileCommon {
  type: 'text';
  tools: ProfileToolsSpec;
  inputs: ProfileInputsSpec;
  /** Resume + mid-turn steering policy. */
  turnBehaviour?: ProfileTurnBehaviourSpec;
}

/** Image-generation primary role. */
export interface ImageProfile extends ProfileCommon {
  type: 'image';
  image: ProfileImageSpec;
  tools: ProfileToolsSpec;
  inputs: ProfileInputsSpec;
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

/** Bidirectional live session. */
export interface LiveProfile extends Omit<ProfileCommon, 'outputs'> {
  type: 'live';
  live: ProfileLiveSpec;
  tools: LiveProfileToolsSpec;
  /**
   * Stage inject gate only (`allowSteering`). Resumption is `live.sessionResumption`,
   * not `turnBehaviour.resumption` (`docs/contracts/stages.md`).
   */
  turnBehaviour?: Pick<ProfileTurnBehaviourSpec, 'allowSteering'>;
}

/**
 * Host-driven tool execution ceiling — never runs a model.
 *
 * `invokeTool` under a `host` profile executes any tool in `tools.allow` with no
 * visibility or loading tiers and no path gating. No `models`, `identity`,
 * `inputs`, `outputs`, `turnBehaviour`, `key`, or `maxSteps`. `resolveTurn`,
 * `runTurn`, and `runSession` refuse it.
 *
 * `guardrails` is narrowed to {@link HostGuardrailsSpec}: only the guards that
 * fire on the `invokeTool` path. Quota, canary, and egress guard a model turn,
 * so `defineProfile` refuses them here rather than accepting inert config.
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

/** Complete host-owned agent contract consumed by the kernel. */
export type Profile =
  | TextProfile
  | ImageProfile
  | SpeechProfile
  | LiveProfile
  | DecisionProfile
  | HostProfile;

/** Profiles that run a model turn — every type except `host` and `decision` (which runs through `runDecision`). */
export type ModelProfile = Exclude<Profile, HostProfile | DecisionProfile>;

/** Text part sent to provider adapters after input normalization. */
export interface InteractionTextPart {
  type: 'text';
  text: string;
}

/** Inline media part sent to provider adapters after MIME validation. */
export interface InteractionMediaPart {
  type: MediaInputKind;
  mimeType: string;
  data: string;
}

/**
 * Media part carried by reference (e.g. a Gemini Files `files/<id>` uri).
 * The host owns the upload and cleanup; THEOREM only carries the reference.
 * Wired by the Google Interactions adapter; other adapters reject it.
 */
export interface InteractionMediaRefPart {
  type: MediaInputKind;
  mimeType: string;
  uri: string;
}

/** Any provider input part accepted by THEOREM's provider contract. */
export type InteractionPart = InteractionTextPart | InteractionMediaPart | InteractionMediaRefPart;

/** Native image response request passed to image-capable providers. */
export interface ImageResponseFormat {
  type: 'image';
  /** Omitted when the profile does not pin MIME; providers use their default. */
  mimeType?: string;
  /** Omitted when the profile does not pin aspect; providers use their default. */
  aspectRatio?: string;
  /**
   * Authoring / kernel name; adapters map to provider wire keys (e.g. Google `imageSize`).
   * Omitted when the profile does not pin size; providers use their default.
   */
  size?: string;
  /** Request assistant text alongside generated images when the provider supports it. */
  includeText: boolean;
}

/** Base64-encoded blob supplied by a host turn request. */
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

/** Provider-neutral history message preserving text, parts, tools, and metadata. */
export interface TurnHistoryMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  parts?: InteractionPart[];
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
    thoughtSignature?: string;
  }>;
  tool_call_id?: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

/** Generic repair request used for validation and egress retry turns. */
export interface TurnRepairRequest {
  previousOutput: string;
  rejection: string;
  guidance?: string;
}

/** User, media, history, and repair payload for a turn. */
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
  /** Optional session resumption handle for continuing live WebSocket sessions. */
  sessionResumptionHandle?: string;
}

/** Host request after kernel ingress normalization. */
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

/** Host request for a single deterministic agent turn. */
export interface TurnRequest {
  profile: ProfileId;
  /** Caller project id when one exists. Omitted on some HTTP hosts. */
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
  /** Session permissions granted for this conversation turn */
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
  /** Earlier turns this one resumes, continues or retries. */
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
  /** Provider for the compaction profile when `timing: 'before'`. Falls back to the turn provider. */
  compactionProvider?: ModelProvider;
  /** Optional session resumption handle for continuing live WebSocket sessions. */
  sessionResumptionHandle?: string;
  /** Host credentials for authenticated HTTP / MCP tools keyed by auth slot. */
  credentials?: Record<string, ToolCredential>;
  /**
   * Turn-stage handler (`docs/contracts/stages.md`).
   * Text `runTurn` emits stages and applies returned affordances.
   */
  onStage?: StageHandler;
}

/** Safe profile projection suitable for UI or host inspection (model profiles only). */
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

/** Provider selection and generation knobs shared before and after resolution. */
export interface ProviderGenerationConfig {
  model: ModelId;
  /** Provider wire model id taken from the profile model spec. */
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
  /**
   * Location bias for Interactions `google_maps`.
   * Copied from `TurnRequest.googleMapsLocation` when present.
   */
  googleMapsLocation?: { latitude: number; longitude: number };
  /**
   * OpenRouter prompt-cache policy from the selected model binding.
   * Omitted for non-openrouter bindings.
   */
  cache?: CacheSpec;
  /**
   * OpenRouter sticky session id from `TurnRequest.sessionId`.
   * Forwarded as request `session_id` when present.
   */
  sessionId?: string;
}

/** Resolved provider transport derived once in `resolveTurn`. */
export type ProviderTransport = 'interactions' | 'geminiLive' | 'openAiCompat';

/** Fully-resolved provider request state created from a `TurnRequest`. */
export interface ResolvedGeneration extends ProviderGenerationConfig {
  /** Resolved transport — `'interactions'` for Google Gemini Interactions, `'geminiLive'` for Gemini Live WebSocket, `'openAiCompat'` otherwise. */
  transport: ProviderTransport;
  /** Mutable tool visibility and wire snapshot for this turn. */
  tools: TurnToolSnapshot;
  sessionPermissions?: string[];
  history?: TurnHistoryMessage[];
  /**
   * Interactions-only: messages sent after `previousInteractionId` (tool
   * results, stage injects) instead of history + user parts. The model reads
   * the stored interaction plus these.
   */
  continuation?: TurnHistoryMessage[];
  /**
   * Tool-loop ceiling. `undefined` or `<= 0` = unbounded.
   * Taken from `profile.maxSteps` with no THEOREM invent.
   */
  maxSteps?: number;
  structured: StructuredSchemaId | null;
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
  /** Optional session resumption handle for continuing live WebSocket sessions. */
  sessionResumptionHandle?: string;
  /**
   * Merged profile + turn system prompt, snapshotted synchronously in `resolveTurn`
   * before any async work. Runner applies canary bind on top of this string.
   */
  resolvedSystem: string;
  /** `TurnRequest.host`, carried to tool contexts only. Never sent to providers or traces. */
  host?: unknown;
}

/** Money a provider reported for one model call. */
export interface TurnCost {
  /** What the provider charged, in US dollars. */
  usd: number;
  /** What the upstream model vendor charged the provider, when reported (OpenRouter). */
  upstreamUsd?: number;
  /**
   * Set on a sum (`sumTokens`) when some summed calls reported a cost and
   * others did not: `usd` covers only the calls that did.
   */
  partial?: true;
}

/** A side of `TurnTokens` the provider did not report. */
export type TurnTokenSide = 'input' | 'output';

/**
 * Token accounting for one model call, one `tokens` event per call.
 *
 * Meanings follow the OpenTelemetry GenAI conventions on every provider:
 * `input` counts everything the model read (cached prompt and provider
 * tool-use tokens included), `output` everything it wrote (reasoning
 * included), and `total` is `input + output`.
 */
export interface TurnTokens {
  input: number;
  output: number;
  /** Reasoning share of `output`. */
  thinking?: number;
  /** Provider tool-use share of `input` (Google code execution / URL context results). */
  toolUse?: number;
  /** Share of `input` read from provider cache (cache hit). */
  cached?: number;
  /** Share of `input` written into provider cache. */
  cacheWrite?: number;
  total: number;
  /** Provider-reported cost. Absent when the provider reports none. */
  cost?: TurnCost;
  /**
   * Sides the provider did not report. The runner replaces each with the one
   * token estimator's count before the event reaches the host. Absent = both
   * sides provider-reported.
   */
  estimated?: TurnTokenSide[];
  /**
   * Media parts left out of an estimated side because no verified rule counts
   * them, per side. Absent when every part was counted.
   */
  unknownMedia?: Partial<Record<TurnTokenSide, number>>;
  /**
   * Provider-reported shares of each side by modality (`text`, `image`,
   * `audio`, …, lower-case). Providers list only some modalities, so the
   * shares need not add up to the side. Absent = not reported.
   */
  byModality?: Partial<Record<TurnTokenSide, Record<string, number>>>;
  /** Provider-side grounding tool use, as the provider reported it. Absent = not reported. */
  grounding?: TurnGroundingCount[];
}

/** A provider response's identity, as the wire sent it. Live sends neither field. */
export interface TurnResponse {
  /** Provider response id (OpenAI-compatible `id`, Interactions `id`). */
  id?: string;
  /** Model that served the call, as the provider names it. */
  model?: string;
}

/** One grounding tool's use in a call (Interactions `grounding_tool_count`). */
export interface TurnGroundingCount {
  /** Provider's tool name, e.g. `google_search`. */
  type: string;
  count: number;
  /** Search queries the tool ran. Absent = not reported. */
  searchQueryCount?: number;
}

/** Normalized citation or place source surfaced from a provider. */
export interface GroundingSource {
  title: string;
  uri: string;
  type: 'maps' | 'web';
  /** Google Place id when the source is a Maps place / place_citation. */
  placeId?: string;
}

/** Google grounding metadata normalized into a stream event. */
export interface GroundingEvent {
  metadata?: Record<string, unknown>;
  chunks?: unknown[];
  searchHtml?: string;
  sources: GroundingSource[];
}

/** Provider evidence such as OpenRouter citations or Google server-side tool steps. */
export interface ProviderEvidenceEvent {
  provider: 'openrouter' | 'google' | string;
  raw?: Record<string, unknown>;
  citations?: string[];
  annotations?: unknown[];
  sources?: GroundingSource[];
  /**
   * Discriminant for evidence payloads.
   * Live ASR uses `input_transcription` / `output_transcription`; Live
   * `voiceActivity` uses `voice_activity`; resumption uses
   * `session_resumption`; code execution uses `code_execution_call` /
   * `code_execution_result` (Live sends only results).
   */
  kind?:
    | 'code_execution_call'
    | 'code_execution_result'
    | 'input_transcription'
    | 'output_transcription'
    | 'session_resumption'
    | 'voice_activity'
    | string;
  /** Generated Python (or other) source from `code_execution_call.arguments.code`. */
  code?: string;
  /** Language of `code` when the API supplies it (typically `python`). */
  language?: string;
  /** Stdout / sandbox output from `code_execution_result.result`. */
  result?: string;
  /** `true` when the sandbox reported an execution error. */
  isError?: boolean;
  /** Step id (`code_execution_call.id`). */
  id?: string;
  /** Links a result to its call (`code_execution_result.call_id`). */
  callId?: string;
  /** Live ASR: partial/interim chunk (vs final transcription delta). */
  interim?: boolean;
  /** Live session resumption: whether the handle may be used to resume. */
  resumable?: boolean;
  /**
   * The provider started this step and never finished it (the stream ended
   * first). `raw` holds what arrived. A partial tool call is evidence only and
   * never runs.
   */
  partial?: boolean;
}

/** Compaction signal emitted in the `done` event when `timing: 'after'`. */
export interface CompactionSignal {
  needed: boolean;
  /** Which meter produced `tokens`. */
  meter: CompactionMeter;
  /** Token count used for the compaction decision. */
  tokens: number;
  /** Media parts not counted in `tokens` — no verified rule for this model. */
  unknownMedia: number;
  /**
   * Full-prompt input tokens of this turn's last model call, when one
   * completed. Always observability; also the decision value when
   * `meter: 'input'`.
   */
  promptTokens?: number;
  /** True when `promptTokens` is the token estimator's count — the provider reported none. */
  promptTokensEstimated?: boolean;
  history: TurnHistoryMessage[];
}

/** Public event yielded by providers and by `runTurn`. */
export interface TurnEvent {
  type: TurnEventType;
  text?: string;
  tool?: ToolCallEvent & {
    /** Provider-native tool call id when present. */
    id?: string;
    arguments?: Record<string, unknown>;
  };
  structured?: unknown;
  media?: { mimeType: string; data: string };
  grounding?: GroundingEvent;
  evidence?: ProviderEvidenceEvent;
  session?: SessionEvent;
  /** Guardrail decision for this turn — rule identity and offsets, never content. */
  guardrail?: GuardrailEvent;
  tokens?: TurnTokens;
  interactionId?: string;
  /** Session resumption handle updated during live sessions. */
  sessionResumptionHandle?: string;
  /** True when a user utterance interrupted an in-flight live model response (barge-in). */
  interrupted?: boolean;
  /** Public-safe failure text for hosts to show users: the wording for `errorKind`. */
  error?: string;
  /** What kind of failure an `error` event is — for the builder, in code. */
  errorKind?: ErrorKind;
  /**
   * The lexicon key and parameters behind `error` when the failure has wording
   * more specific than its kind's; a list when it found several problems.
   */
  errorCopy?: ErrorCopy | readonly ErrorCopy[];
  /**
   * Raw diagnostic detail for traces/logs, on an `error` event or an ended
   * session's close; never surface to end users (`forClient` strips it).
   */
  errorInternal?: string;
  /** Compaction signal for `timing: 'after'` profiles. Present only on `done` events. */
  compaction?: CompactionSignal;
  /** Why the turn ended. Present on terminal `done` events when known. */
  stop?: TurnStop;
  /**
   * On the terminal `done`: the turn's root span as a W3C `traceparent`. Pass
   * it in a later request's `links` to connect the two records.
   */
  traceparent?: string;
  /**
   * On a provider's `response` event: the identity the wire named so far,
   * emitted as soon as it is named and again when it grows or changes.
   */
  response?: TurnResponse;
  /**
   * Turn tool visibility snapshot when `stop.kind === 'tool'`.
   * Hosts pass this to `invokeTool({ snapshot })` so T1/T2 resume matches the gated turn.
   */
  tools?: TurnToolSnapshot;
  /** Turn-stage name when `type === 'stage'` (`docs/contracts/stages.md`). */
  stage?: TurnStage;
  /** Tool call id on `stage` / related tool-stage events. */
  callId?: string;
  /** Tool name on `stage` events (`pre_tool` / `post_tool`). Not `tool` (ToolCallEvent). */
  toolName?: string;
  /** True when a tool completed with awaiting_user_input (on stage/tool events). */
  awaiting?: boolean;
  /** pre_tool gate payload when `tool.phase === 'gate'` or stage carries a gate. */
  gate?: ToolGate;
  /** True when pre_tool settled without running the body. */
  callNotStarted?: boolean;
  /**
   * Host-visible stage affordance warnings (`docs/contracts/stages.md`).
   * Emitted after `onStage` when invalid/rejected fields were dropped.
   */
  stageWarnings?: StageApplyWarning[];
}

/**
 * Provider-neutral request object sent from the kernel to a model adapter.
 *
 * Several fields are **Google Interactions-only** and omitted otherwise:
 * `previousInteractionId`, `store`, `stream`, `summaries`,
 * `continuation`.
 * Adapters must tolerate their absence. `keySlot` is shared by Google and
 * OpenRouter vault resolution (required for Google; optional for OpenRouter).
 */
export interface ProviderCompleteRequest extends Omit<ProviderGenerationConfig, 'summaries'> {
  /**
   * Interactions-only: thinking-summary behavior.
   * Omitted (undefined) for non-Google providers.
   */
  summaries?: SummaryMode;
  system: string;
  input: InteractionPart[];
  history?: TurnHistoryMessage[];
  /**
   * Interactions-only: messages sent after `previousInteractionId` (tool
   * results, stage injects) instead of history + user parts; the adapter maps
   * them like history. Omitted for non-Google providers.
   */
  continuation?: TurnHistoryMessage[];
  /** Function tool wire declarations derived from the turn tool snapshot. */
  wireTools?: WireFunctionTool[];
  structured: StructuredSchemaId | null;
  image: ImageResponseFormat | null;
  speech?: ProfileSpeechSpec;
  live?: ProfileLiveSpec;
  /** Optional session resumption handle for continuing live WebSocket sessions. */
  sessionResumptionHandle?: string;
  /**
   * Vault key slot. Required for Google; set for OpenRouter when the profile
   * pins `model.key` or a builtin forces `paid`. Never sent on the wire.
   */
  keySlot?: KeySlot;
  /** Scrubbed SSE / HTTP rows for traces. */
  tapUpstream?: (row: Record<string, unknown>) => void;
  /** Host abort signal — adapters should pass this into fetch / SDK calls. */
  signal?: AbortSignal;
}

/** Minimal adapter contract every model provider must implement. */
export interface ModelProvider {
  complete: (req: ProviderCompleteRequest) => AsyncIterable<TurnEvent>;
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
  /** Earlier sessions or turns this one resumes or continues. */
  links?: TurnTraceLink[];
  /**
   * Session-lifetime stage handler (`docs/contracts/stages.md`). Immutable for
   * the session; no `setOnStage`.
   */
  onStage?: StageHandler;
  /** Default credentials for `executeTool` (per-call args override). */
  credentials?: Record<string, ToolCredential>;
  /** Opaque host slot for stages / tool execute (per-call args override). */
  host?: unknown;
}

/**
 * Long-lived live session returned by `runSession`.
 * `done` events mark conversational turn boundaries; the session stays open until `close()`.
 */
export type LiveExecuteToolArgs = {
  name: string;
  callId: string;
  input?: unknown;
  resume?: InvokeToolResume;
  credentials?: Record<string, ToolCredential>;
  host?: unknown;
};

/** Outcome of executing a registry tool through an open live session. */
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
   * Registry tool execute with stages. Pumps `stage`/`tool` into `events()`.
   * Gate → returns `gated` without upstream tool response; resume with `granted`.
   */
  executeTool(args: LiveExecuteToolArgs): Promise<LiveExecuteToolResult>;
  sendToolResponse(id: string, name: string, output: unknown): void;
  sendToolResponses(responses: Array<{ id: string; name: string; output: unknown }>): void;
  close(reason?: string): Promise<void>;
}
