/**
 * Shared type contracts for THEORUM profiles, turns, provider adapters, tools,
 * guardrails, and stream events.
 *
 * Import from `jsr:@theorum/core/kernel` or `theorum/kernel` when a host app needs types without
 * importing provider implementations.
 *
 * @module
 */

import type {
  CompactionMeter,
  CompactionTiming,
  ControlId,
  EgressOnBlock,
  FieldMeta,
  GeminiBucket,
  GeminiFreeBucket,
  LiveActivityHandling,
  LiveContextCompression,
  LiveSpeechSensitivity,
  MediaInputKind,
  Protocol,
  Provider,
  SchemaEnforcement,
  SpeechAudioFormat,
  StreamMode,
  SummaryMode,
  ThinkingLevel,
  ToolLoadTier,
  TurnStopKind,
} from './schema.ts';
import type {
  InvokeToolRequest,
  ProfileToolsSpec,
  RegisteredTool,
  ToolCallEvent,
  ToolLoadContext,
  ToolPolicy,
  TurnToolSnapshot,
  WireFunctionTool,
} from './tools/types.ts';

export type {
  CompactionMeter,
  CompactionTiming,
  ControlId,
  EgressOnBlock,
  FieldMeta,
  GeminiBucket,
  GeminiFreeBucket,
  InvokeToolRequest,
  LiveActivityHandling,
  LiveContextCompression,
  LiveSpeechSensitivity,
  MediaInputKind,
  ProfileToolsSpec,
  Protocol,
  Provider,
  RegisteredTool,
  SchemaEnforcement,
  SpeechAudioFormat,
  StreamMode,
  SummaryMode,
  ThinkingLevel,
  ToolCallEvent,
  ToolLoadContext,
  ToolLoadTier,
  ToolPolicy,
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
 * The image model itself lives in `model.allow` / `model.config`.
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
  | 'done'
  | 'error';

/** Provider thinking levels used when a boolean thinking control is on or off. */
export interface ThinkingMap {
  on: ThinkingLevel;
  off: ThinkingLevel;
}

/** Provider summary behavior used when a boolean thinking control is on or off. */
export interface SummaryMap {
  on: SummaryMode;
  off: SummaryMode;
}

/** Host-declared metadata THEORUM needs to call a model safely. */
export interface ModelSpec {
  /** Provider wire model id for the configured provider. */
  apiId: string;
  /** Thinking on/off map when the profile lists `thinking` in controls. Omit → provider default. */
  thinking?: ThinkingMap;
  /** Levels this model accepts. Illegal values are clamped via `thinkingLevels`. */
  thinkingLevels?: ThinkingLevel[];
  /** Thinking-summary on/off map. Omit → provider default. */
  summaries?: SummaryMap;
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
   * Optional vault slot for this model. When set, overrides `profile.model.key`.
   * Host-owned — e.g. pin image models to `paid`.
   */
  key?: GeminiBucket;
  /** Optional compaction policy for this model's context window (chat profiles). */
  compaction?: CompactionSpec;
  /** Gemini Interactions: whether the provider stores the interaction. Omit → provider default. */
  store?: boolean;
  /**
   * Gemini Interactions: prefer server-side thread via `previous_interaction_id`
   * instead of client-owned history. Omit → host/turn decides.
   */
  persistViaInteractionId?: boolean;
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

/** Host-registered structured output schema and enforcement mode. */
export interface StructuredSpec {
  enforced: SchemaEnforcement;
  jsonSchema?: Record<string, unknown>;
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
  repairGuidance?: string;
}

/**
 * Speech-role output pins owned by the host profile.
 * The speech model itself lives in `model.allow` / `model.config`.
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

/** Audio transcription toggles for live sessions. */
export interface LiveTranscriptionSpec {
  input?: boolean;
  output?: boolean;
}

/**
 * Output pins for a live-role profile (bidirectional WebSocket audio/video session).
 * The live model itself lives in `model.allow` / `model.config`.
 */
export interface ProfileLiveSpec {
  /** Output TTS voice name (e.g. 'Puck', 'Aoede', 'Charon'). */
  voice?: string;
  /** Voice activity detection & barge-in configuration. */
  vad?: LiveVadSpec;
  /** Whether session resumption updates and reconnection handles are enabled. */
  sessionResumption?: boolean;
  /** Context window compression mechanism (e.g. 'slidingWindow' or 'none'). */
  contextCompression?: LiveContextCompression;
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
   * Omit → leave to provider transport default (no THEORUM invent).
   */
  mode?: StreamMode;
  /** When false, filter `thought` events from the turn stream. */
  streamThoughts?: boolean;
}

export type { ProfileTurnResumptionSpec, TurnContinueFrom, TurnStop } from './stop.ts';

import type { ProfileTurnResumptionSpec, TurnContinueFrom, TurnStop } from './stop.ts';

/** Profile wire/session archetype. Required on every profile — no inference shims. */
export type ProfileType = 'text' | 'image' | 'speech' | 'live';

/** Context passed to a host-owned outbound disclosure guard. */
export interface EgressContext {
  text: string;
  canary?: string;
  slots?: Record<string, string>;
  profile: Profile;
  role?: string;
}

/** Decision returned by an egress guard. */
export interface EgressEnforcementResult {
  blocked: boolean;
  text: string;
  hits?: string[];
  rejectionMessage?: string | null;
}

/** Function that evaluates candidate user-visible output before release. */
export type EgressEnforcer = (
  context: EgressContext,
) => EgressEnforcementResult | Promise<EgressEnforcementResult>;

/** Profile egress policy for rejection, retry, or refusal behavior. */
export interface ProfileEgressSpec {
  enforce: EgressEnforcer;
  onBlock?: EgressOnBlock;
  maxRetries?: number;
  repairGuidance?: string;
}

/** Profile guardrail switches enforced by the kernel. */
export interface ProfileGuardrailsSpec {
  /** Optional daily turn quota; omitted means quota enforcement is not configured. */
  quota?: { perDay: number };
  canary?: boolean;
  sanitizeInput?: boolean;
  redactSensitive?: boolean;
  egress?: ProfileEgressSpec;
}

/** Model, provider, thinking, and step bounds for a profile. */
export interface ProfileModelSpec {
  protocol: Protocol;
  provider: Provider;
  /** Ids this profile may select. Each id must exist in `config`. */
  allow: ModelId[];
  /** Host-owned wire config keyed by the same ids used in `allow` / `select`. */
  config: Record<ModelId, ModelSpec>;
  select?: Record<string, ModelId>;
  thinking?: ThinkingLevel | Record<string, ThinkingLevel>;
  controls?: ControlId[];
  /**
   * Tool-loop ceiling. `<= 0` = unbounded; `1` = one-shot; `> 1` = hard cap.
   * Omit → unbounded (no THEORUM invent of `1`).
   */
  maxSteps?: number;
  key?: GeminiFreeBucket;
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
  model: ProfileModelSpec;
  outputs?: ProfileOutputsSpec;
  guardrails?: ProfileGuardrailsSpec;
}

/** Text / structured turn engine with optional tool execution. */
export interface TextProfile extends ProfileCommon {
  type: 'text';
  tools: ProfileToolsSpec;
  inputs: ProfileInputsSpec;
  turnResumption?: ProfileTurnResumptionSpec;
}

/** Image-generation primary role. */
export interface ImageProfile extends ProfileCommon {
  type: 'image';
  image: ProfileImageSpec;
  tools: ProfileToolsSpec;
  inputs: ProfileInputsSpec;
  turnResumption?: ProfileTurnResumptionSpec;
}

/** Unary TTS — text-in locked by type; no tools / inputs block. */
export interface SpeechProfile extends ProfileCommon {
  type: 'speech';
  speech: ProfileSpeechSpec;
  turnResumption?: ProfileTurnResumptionSpec;
}

/** Bidirectional live session. */
export interface LiveProfile extends ProfileCommon {
  type: 'live';
  live: ProfileLiveSpec;
  tools: ProfileToolsSpec;
  inputs?: ProfileInputsSpec;
}

/** Complete host-owned agent contract consumed by the kernel. */
export type Profile = TextProfile | ImageProfile | SpeechProfile | LiveProfile;

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

/** Any provider input part accepted by THEORUM's provider contract. */
export type InteractionPart = InteractionTextPart | InteractionMediaPart;

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
  attachments?: TurnBlob[];
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

/** Host request for a single deterministic agent turn. */
export interface TurnRequest {
  profile: ProfileId;
  /** Caller project id when one exists. Omitted on some HTTP hosts. */
  projectId?: string;
  /** Google Interactions server-side conversation state. Omit for stateless/manual history. */
  previousInteractionId?: string;
  /** Optional Interactions storage override. Omit to let profile model.config / provider decide. */
  store?: boolean;
  select?: string;
  thinking?: boolean;
  /** Host-provided dynamic system prompt combined with profile persona */
  system?: string;
  /** Session permissions granted for this conversation turn */
  sessionPermissions?: string[];
  /** Host channel/path for catalog `paths` filtering. */
  path?: string;
  /** Host-owned metadata preserved for traces; the kernel does not interpret it. */
  metadata?: Record<string, unknown>;
  /**
   * Optional abort signal. When aborted, THEORUM stops the turn and cancels
   * in-flight provider HTTP where the adapter supports it.
   */
  signal?: AbortSignal;
  /**
   * Continue a prior resumeable stop. Kernel appends CONTINUE_INSTRUCTION to
   * the system prompt; hosts should also pass partial artifact via input/history.
   */
  continueFrom?: TurnContinueFrom;
  /**
   * 1-based continue attempt when `continueFrom` is set.
   * Compared to `profile.turnResumption.maxContinues` when that cap is set.
   */
  continuation?: number;
  input?: TurnInput;
  /** Provider for the compaction profile when `timing: 'before'`. Falls back to the turn provider. */
  compactionProvider?: ModelProvider;
  /** Optional session resumption handle for continuing live WebSocket sessions. */
  sessionResumptionHandle?: string;
}

/** Safe profile projection suitable for UI or host inspection. */
export interface ProjectedProfile {
  id: string;
  type: ProfileType;
  handle: string;
  maxSteps: number | null;
  models: ModelId[];
  select: Record<string, ModelId> | null;
  controls: ControlId[];
  tools: Array<RegisteredTool | { name: ToolId; missing: true }>;
  inputs: ProfileInputsSpec | null;
  slots: Record<string, string[]>;
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
   * `true` = SSE; `false` = buffered; omit = provider default.
   */
  stream?: boolean;
  thinking: ThinkingLevel;
  summaries?: SummaryMode;
  maxOutputTokens?: number;
  temperature?: number;
  builtins: BuiltinToolId[];
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
   * Interactions-only: when set, sent as the request `input` array instead of
   * history + user parts (e.g. a lone `function_result` continuation step).
   */
  interactionOnlyInput?: Record<string, unknown>[];
  /**
   * Tool-loop ceiling. `undefined` or `<= 0` = unbounded.
   * Taken from `profile.model.maxSteps` with no THEORUM invent.
   */
  maxSteps?: number;
  structured: StructuredSchemaId | null;
  image: ImageResponseFormat | null;
  speech?: ProfileSpeechSpec;
  live?: ProfileLiveSpec;
  input: InteractionPart[];
  /**
   * Gemini vault slot for Google transports only.
   * Omitted for non-Google providers; never sent on the wire.
   */
  geminiBucket?: GeminiBucket;
  canary: string;
  /** Optional session resumption handle for continuing live WebSocket sessions. */
  sessionResumptionHandle?: string;
}

/** Token accounting emitted by providers or fallback estimation. */
export interface TurnTokens {
  input: number;
  output: number;
  thinking?: number;
  toolUse?: number;
  /** Google code-execution / tool intermediate tokens when the API reports them. */
  intermediate?: number;
  total: number;
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
  /** Interactions server-side step type when this event is a Google builtin payload. */
  kind?: 'code_execution_call' | 'code_execution_result' | string;
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
}

/** Compaction signal emitted in the `done` event when `timing: 'after'`. */
export interface CompactionSignal {
  needed: boolean;
  /** Which meter produced `tokens`. */
  meter: CompactionMeter;
  /** Token count used for the compaction decision. */
  tokens: number;
  /**
   * Provider-reported full-prompt input tokens from this turn, when known.
   * Always observability; also the decision value when `meter: 'input'`.
   */
  promptTokens?: number;
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
  tokens?: TurnTokens;
  interactionId?: string;
  /** Session resumption handle updated during live sessions. */
  sessionResumptionHandle?: string;
  /** True when a user utterance interrupted an in-flight live model response (barge-in). */
  interrupted?: boolean;
  /** Public-safe failure text for hosts to show users. */
  error?: string;
  /** Raw diagnostic detail for traces/logs; never surface to end users. */
  errorInternal?: string;
  /** Compaction signal for `timing: 'after'` profiles. Present only on `done` events. */
  compaction?: CompactionSignal;
  /** Why the turn ended. Present on terminal `done` events when known. */
  stop?: TurnStop;
}

/**
 * Provider-neutral request object sent from the kernel to a model adapter.
 *
 * Several fields are **Interactions-only** and omitted for non-Google providers:
 * `previousInteractionId`, `store`, `stream`, `summaries`,
 * `interactionOnlyInput`, `geminiBucket`.
 * Adapters must tolerate their absence.
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
   * Interactions-only: when set, sent as the request `input` array instead of
   * history + user parts (e.g. a lone `function_result` continuation step).
   * Omitted for non-Google providers.
   */
  interactionOnlyInput?: Record<string, unknown>[];
  /** Function tool wire declarations derived from the turn tool snapshot. */
  wireTools?: WireFunctionTool[];
  structured: StructuredSchemaId | null;
  image: ImageResponseFormat | null;
  speech?: ProfileSpeechSpec;
  live?: ProfileLiveSpec;
  /** Optional session resumption handle for continuing live WebSocket sessions. */
  sessionResumptionHandle?: string;
  /**
   * Gemini vault slot for Google Interactions transport only.
   * Required when completing via Google Interactions; omitted otherwise.
   */
  geminiBucket?: GeminiBucket;
  /** Scrubbed SSE / HTTP rows for traces. */
  tapUpstream?: (row: Record<string, unknown>) => void;
  /** Host abort signal — adapters should pass this into fetch / SDK calls. */
  signal?: AbortSignal;
}

/** Minimal adapter contract every model provider must implement. */
export interface ModelProvider {
  complete: (req: ProviderCompleteRequest) => AsyncIterable<TurnEvent>;
}
