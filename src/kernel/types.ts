import type { ProviderCheckpoint, ProviderContinuationPolicy } from './checkpoint.ts';
import type { JsonObject } from './json.ts';
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
  SpeechAudioFormat,
  StreamMode,
  SummaryMode,
  ThinkingLevel,
  ToolLoadTier,
  TurnStage,
  TurnStopKind,
} from './schema.ts';
import type { StageHandler } from './stages.ts';
import type { ToolBackgroundService } from './tools/background.ts';
import type { GateDecision } from './tools/gate-answer.ts';
import type {
  PageToolExecution,
  ToolExecutionCoordinator,
  ToolOperationOutcome,
} from './tools/operation.ts';
import type {
  AgentCall,
  AgentCallHook,
  AgentCallRequest,
  AgentToolDef,
  AgentToolInput,
  AgentToolOutput,
  HostProfileToolsSpec,
  InvokeToolRequest,
  InvokeToolResume,
  InvokeToolStepCall,
  InvokeToolStepRequest,
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
  AttemptReason,
  CallDone,
  CompactionFailure,
  CompactionResult,
  CompactionSignal,
  DoneFields,
  GroundingEvent,
  InjectedMessages,
  InteractionMediaPart,
  InteractionMediaRefPart,
  InteractionPart,
  InteractionTextPart,
  InvalidField,
  ModelEvent,
  ProviderEvidence,
  RemovedItem,
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
  AttemptReason,
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
  InjectedMessages,
  InteractionMediaPart,
  InteractionMediaRefPart,
  InteractionPart,
  InteractionTextPart,
  InvalidField,
  InvokeToolRequest,
  InvokeToolResume,
  InvokeToolStepCall,
  InvokeToolStepRequest,
  KeySlot,
  KeyVault,
  LiveActivityHandling,
  LiveEndSensitivity,
  LiveProfileToolsSpec,
  LiveStartSensitivity,
  MediaInputKind,
  ModelEvent,
  ProfileToolsSpec,
  ProfileType,
  ProviderEvidence,
  RegisteredTool,
  RemovedItem,
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

/** A provider-side tool the turn uses, with the args the request addressed to it. */
export interface ProviderBuiltin {
  id: BuiltinToolId;
  args?: JsonObject;
}

/** Args a request hands to built-in tools, each checked by the schema its adapter declares. */
export type BuiltInArgs = Record<BuiltinToolId, JsonObject>;

/** The id a profile is registered and run under. */
export type ProfileId = string;

/** The roles a history message can carry. */
export type ChatRole = 'system' | 'user' | 'assistant';

/** Host strings (presets own the vocabularies); an unpinned value is the provider default. */
export interface ProfileImageSpec {
  /** The shape of generated images, such as 16:9. */
  aspectRatio?: string;
  /** How detailed generated images are, such as 1K, 2K or 4K. */
  resolution?: string;
  /**
   * The file type of generated images; a provider that takes a fixed set of types may use png for
   * any other.
   */
  mimeType?: string;
  /**
   * How much effort the model spends on each image: auto, low, medium, or high. A provider that has
   * no such setting refuses it.
   */
  quality?: string;
  /**
   * The background of generated images: auto, transparent, or opaque. A provider that has no such
   * setting refuses it.
   */
  background?: string;
  /** How many images one request makes, where the provider takes a count. */
  n?: number;
  /** A seed for repeatable images, where the provider and the model honour it. */
  seed?: number;
  /** Compression from 0 to 100 for jpeg and webp images, where the provider takes it. */
  outputCompression?: number;
  /**
   * Images sent with every turn, before the user's. Each is bytes (`data`) or a link (`uri`). Some
   * providers take http(s) links only, and none with includeText.
   */
  references?: Array<TurnBlob | TurnMediaRef>;
  /**
   * Whether the model may write text alongside its images; with some providers this also sends the
   * system instruction and history.
   *
   * @remarks Also request interleaved text with the images (Google: text + image
   * `response_format`).
   */
  includeText?: boolean;
}

import type { DecisionModelBinding, ModelBinding } from './protocols/binding.ts';
import type { ProviderHostOptions } from './protocols/runtime.ts';

export type { DecisionModelBinding, ModelBinding };

/**
 * OpenRouter prompt-cache policy (`models.*.options.cache`).
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

/** When history compacts and how: the meter, the token budget, and the compactor. */
export interface CompactionSpec {
  /**
   * The token budget compactAt is a fraction of.
   *
   * @remarks Token budget compared by the trigger (`compactAt * maxTokens`). Meaning depends on
   * `meter`: history budget vs full-prompt input budget.
   */
  maxTokens: number;
  /**
   * The fraction of maxTokens, between 0 and 1, at which compaction starts, unless trigger decides.
   *
   * @remarks Fraction of `maxTokens` at which compaction fires. Must be in (0, 1).
   */
  compactAt: number;
  /**
   * How much recent history compaction keeps: a number of exchanges (1 or more), a fraction of
   * maxTokens below compactAt, or 0 to compact it all.
   *
   * @remarks Recent exchanges kept verbatim (an exchange is a user message and everything up to the
   * next one). `≥ 1` = exchange count, `(0, 1)` = fraction of `maxTokens`, `0` = compact all.
   */
  previousExchanges: number;
  /**
   * The text profile that writes the summary; register it before this one. Leave it out and a text
   * agent summarises its own history, with its own instructions and model and no tools. Its
   * registered model binding selects the provider independently of the calling agent.
   *
   * @remarks Profile id of the compaction agent. Must be registered before the owning profile. Omit
   * it and the agent compacts its own history: the same instructions and model, no tools.
   */
  profile?: ProfileId;
  /**
   * Whether the kernel compacts before the turn or tells the host to compact after it.
   *
   * @remarks When compaction runs relative to the primary turn.
   * - `'before'`: kernel compacts synchronously before the turn; user pays latency on this turn.
   * - `'after'`: kernel signals in the `done` event; host runs compaction asynchronously.
   */
  timing: CompactionTiming;
  /**
   * What the threshold counts.
   *
   * @remarks Threshold meter. Defaults to `'history'`. Use `'input'` when the host prefers provider
   * full-prompt usage (after subtracting a known baseline in `maxTokens` / `compactAt`).
   */
  meter?: CompactionMeter;
  /**
   * Your function that decides when to compact, in place of compactAt and maxTokens. A throw is
   * reported as hook_failed, and compactAt and maxTokens decide.
   *
   * @remarks Replaces the default `tokens > compactAt * maxTokens` check.
   */
  trigger?: (ctx: CompactionTriggerContext) => boolean | Promise<boolean>;
}

/** What every request that runs a model takes: how to stop it, and where its trace goes. */
export interface RunControls {
  /**
   * Stops the run when it aborts, and cancels its provider call where the provider can.
   *
   * @remarks Stops the run when it aborts, and cancels in-flight provider HTTP where the adapter
   * supports it.
   */
  signal?: AbortSignal;
  /**
   * Your own values, kept on the trace; Theorem does not read them.
   *
   * @remarks Host-owned metadata preserved on the run's trace records; the kernel does not
   * interpret it.
   */
  metadata?: Record<string, unknown>;
  /**
   * The W3C traceparent of your span; the run's trace joins it as a child.
   *
   * @remarks W3C `traceparent` of the host span this run goes under. The run's root span joins that
   * trace as its child; without it the run starts a new trace. A malformed value throws.
   */
  traceparent?: string;
  /** Your project id, recorded on the trace. */
  projectId?: string;
  /**
   * Your conversation id, recorded on the trace.
   *
   * @remarks Host conversation id, recorded as `gen_ai.conversation.id`.
   */
  conversationId?: string;
  /**
   * Earlier traces this run follows: a resume, a continue, or a retry.
   *
   * @remarks Earlier traces this run follows.
   */
  links?: TurnTraceLink[];
}

/** Which of the profile's models a run uses, and how hard it thinks. */
export interface ModelChoice {
  /**
   * The model id the turn or session picks from the profile's models; refused unless the profile
   * sets allowModelSelect.
   *
   * @remarks Selected model id when `profile.allowModelSelect` is true.
   */
  model?: ModelId;
  /**
   * The effort the turn or session picks from the model's efforts; refused unless the model sets
   * allowEffortSelect.
   *
   * @remarks Selected effort alias when the binding has `allowEffortSelect`.
   */
  effort?: string;
}

/** `compactHistory` input, for `timing: 'after'`: the host passes back what `done.compaction` carried. */
export interface CompactHistoryRequest extends RunControls {
  /** The profile whose model binding carries the `compaction` spec. */
  profile: ProfileId;
  /** That binding; defaults to the profile's `defaultModel`. */
  model?: ModelId;
  history: TurnHistoryMessage[];
  /** `done.compaction.tokens`: a failed compactor drops `toCompact` only when this is over `maxTokens`. */
  tokens: number;
}

/** A structured-output schema given inline. */
export interface StructuredSpec {
  /** The JSON Schema a structured reply must follow, sent to the model as its response format. */
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
  | 'too_many_of_kind'
  | 'file_too_large'
  | 'turn_too_large'
  | 'attachments_not_accepted'
  | 'voice_not_accepted'
  | 'limits_unconfigured';

/**
 * Structured parameters for rendering one validation issue. Validation emits
 * codes + params only; the wording is the labels' `attachments.*` lines.
 */
export interface AttachmentValidationParams {
  maxFiles?: number;
  maxBytes?: number;
  maxTurnBytes?: number;
  mimeType?: string;
  /** The kind of media a count is of, such as `PDF` or `image`. */
  kind?: string;
  channel?: 'attachment' | 'voice';
}

/** One reason a turn's files were refused; `fileName` names the file when the problem is one file's. */
export interface AttachmentValidationIssue {
  code: AttachmentValidationCode;
  params?: AttachmentValidationParams;
  fileName?: string;
}

/** Picks the structured-output schema by the value of a turn's option, with a fallback. */
export interface StructuredByOption {
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
  options?: Readonly<Record<string, string>>,
) => ValidationResult | Promise<ValidationResult>;

/** A tool call the turn completed, as an item check reads it. */
export interface TurnToolResult {
  tool: string;
  /** The output the call settled with, after any `post_tool` `mutate`. */
  output: unknown;
}

/** What an item check reads of the turn whose reply it is checking. */
export interface ItemCheckTurn {
  /** The value of each option the turn set. */
  options?: Readonly<Record<string, string>>;
  /** Every tool call the turn completed, in order, across its attempts. */
  toolResults: readonly TurnToolResult[];
}

/** A host function that checks one item of a list against what the turn's tools returned. */
export type ProfileItemCheck = (
  item: unknown,
  turn: ItemCheckTurn,
) => ValidationResult | Promise<ValidationResult>;

/**
 * A host check on each item of one list in a structured reply. A refused item
 * never fails the reply: `drop` removes it, and `fix` first asks the model to
 * rewrite the refused items alone, then removes any that are refused again.
 */
export interface ProfileItemRule {
  /**
   * Your check on one item, given what the tools of the turn returned (turn.toolResults); its error
   * is the reason the model reads on a rewrite and the host reads on the removed item. A throw
   * refuses the item, reported as hook_failed.
   */
  check: ProfileItemCheck;
  /**
   * drop removes a refused item. fix first asks the model to rewrite the refused items alone, once
   * and while retries remain, then removes any refused again. Removed items leave on the structured
   * event as removed.
   */
  onFail: 'drop' | 'fix';
}

/** Host validators a profile runs on its structured output. */
export interface ProfileValidationSpec {
  /**
   * Your checks, each keyed by a dotted path into the structured reply, such as diagram.mermaid; a
   * path no structured schema reaches is refused when the profile registers.
   *
   * @remarks Host domain validators keyed by dotted paths into structured output (e.g.
   * `diagram.mermaid`). Presence/required is owned by the JSON Schema; these run only for required
   * paths and for optional paths that are present.
   *
   * @catalog outputs.validation.fields.* Your check on this part of the reply, reached through object properties only; a failure sends its error back to the model to rewrite while retries remain. A throw is a failure, reported as hook_failed.
   */
  fields?: Record<string, ProfileValidator>;
  /**
   * Your checks on the items of a list, each keyed by the dotted path of that list in the
   * structured reply, such as claims; a path no structured schema reaches as a list is refused when
   * the profile registers.
   *
   * @remarks Host checks on list items, keyed by the dotted path of a list in the structured
   * output.
   *
   * @catalog outputs.validation.items.* Your check on each item of this list. A refused item never fails the reply and the rest of the reply is kept.
   */
  items?: Record<string, ProfileItemRule>;
  /**
   * How many times the model may rewrite a reply that fails your checks or the schema's required
   * keys before it goes out as it is; under sse, an attempt that gets rewritten has already
   * streamed. A rewrite of a blocked reply (guardrails.blockedReply) counts against this too.
   */
  maxRetries?: number;
}

/** `voice` is the TTS voice id, not ingress audio (`inputs.voice`). */
export interface ProfileSpeechSpec {
  /**
   * The voice the speech is read in, by the provider's own name for it; a turn's speech.voice
   * replaces it.
   */
  voice?: string;
  /**
   * How the script is delivered, in plain words (pace, mood, accent); it is never read aloud, and a
   * turn's speech.style replaces it. A model that takes no direction ignores it.
   *
   * @remarks How the script is delivered, in plain words: pace, mood, accent. Never read aloud.
   */
  style?: string;
  /**
   * The speaking rate, where 1 is the voice's own pace; a turn's speech.speed replaces it. A
   * provider that has no rate refuses it or ignores it.
   *
   * @remarks The speaking rate; 1 is the voice's own pace.
   */
  speed?: number;
  /**
   * The audio encoding each turn's speech comes back in, and so what the host plays or stores.
   *
   * @remarks A provider that cannot make the format refuses the turn.
   */
  format?: SpeechAudioFormat;
}

/** What one speech turn sets for itself; each field given replaces the profile's `speech` field of that name. */
export type TurnSpeech = Pick<ProfileSpeechSpec, 'voice' | 'style' | 'speed'>;

/** Voice activity detection settings for a live session. */
export interface LiveVadSpec {
  /** Whether the user speaking interrupts the model's reply. */
  activityHandling?: LiveActivityHandling;
  /** How readily the session decides the user has started speaking. */
  startSensitivity?: LiveStartSensitivity;
  /** How readily the session decides the user has stopped speaking. */
  endSensitivity?: LiveEndSensitivity;
  /** How long speech must last, in milliseconds, before it counts as the user starting to speak. */
  prefixPaddingMs?: number;
  /** How long a silence, in milliseconds, ends the user's speech. */
  silenceDurationMs?: number;
}

/**
 * Context window compression for a live session: once the context reaches the
 * trigger, the mechanism shrinks it. Without it, Gemini ends audio sessions at
 * 15 minutes and audio-video sessions at 2.
 */
export interface LiveContextCompressionSpec {
  /**
   * The context size, in tokens, that starts trimming.
   *
   * @remarks Context tokens, counted before a turn, that start compression. A whole number above 0.
   * Omit → provider default (Gemini: 80% of the model's context window).
   */
  triggerTokens?: number;
  /**
   * Trims by dropping the oldest turns; the system instruction stays.
   *
   * @remarks Drops the oldest turns; the system instruction stays. Gemini's only mechanism.
   */
  slidingWindow: LiveSlidingWindowSpec;
}

/** Sliding-window context compression for a live session. */
export interface LiveSlidingWindowSpec {
  /**
   * The context size, in tokens, to trim down to; below the trigger.
   *
   * @remarks Tokens to keep after compressing. A whole number above 0, below `triggerTokens`. Omit
   * → provider default (Gemini: half of `triggerTokens`).
   */
  targetTokens?: number;
}

/** Which sides of a live session are transcribed. */
export interface LiveTranscriptionSpec {
  /** Whether the user's speech is transcribed. */
  input?: boolean;
  /**
   * Whether the model's speech is transcribed; always on while a detector reads live_reply, since
   * it reads the transcript.
   */
  output?: boolean;
}

/**
 * Realtime ingress modalities for a live session.
 * Distinct from turn `inputs` (file attachments, MIME limits) — these gate
 * `LiveSession.sendAudio` / `sendVideo` / `sendText` channels.
 */
export interface LiveIngressSpec {
  /**
   * Whether the session accepts microphone audio.
   *
   * @remarks Microphone PCM via `sendAudio`. Omit → enabled.
   */
  audio?: boolean;
  /**
   * Whether the session accepts camera frames.
   *
   * @remarks Webcam JPEG frames via `sendVideo`. Omit → enabled.
   */
  video?: boolean;
  /**
   * Whether the session accepts typed text.
   *
   * @remarks Typed text via `sendText`. Omit → disabled (opt-in).
   */
  text?: boolean;
}

/** The prompt a resumed call opens with, and how long away earns it. */
export interface LiveResumedSpec {
  /**
   * A prompt the call sends itself when it resumes, so the agent says it is back. The visitor does
   * not see it. It may use {name}, and is not sent when an option it prints is unset.
   */
  prompt: string;
  /**
   * The shortest time away, in milliseconds, that earns the prompt; a shorter drop resumes
   * silently.
   *
   * @remarks The shortest time away, in milliseconds, the agent remarks on. Omit →
   * `DEFAULT_RESUMED_AFTER_MS`.
   */
  afterMs?: number;
}

/** The settings only a live profile has: ingress, voice, detection, windowing, transcription, and resumption. */
export interface ProfileLiveSpec {
  /** Which channels the session accepts from the user. */
  ingress?: LiveIngressSpec;
  /** The voice the model speaks in. */
  voice?: string;
  /** How the session detects when the user starts and stops speaking. */
  vad?: LiveVadSpec;
  /**
   * Whether the provider sends resume handles, which the host can pass to a new session to carry
   * this one on.
   */
  sessionResumption?: boolean;
  /**
   * A prompt the call sends itself when it opens new, so the agent speaks first. The visitor does
   * not see it. It may use {name}, and is not sent when an option it prints is unset.
   *
   * @remarks A prompt the session sends itself when a call opens new, so the agent speaks first.
   * Omit → the agent waits.
   */
  greeting?: string;
  /**
   * What happens when a call comes back after a drop. It needs live.sessionResumption.
   *
   * @remarks What the agent is prompted with when a call resumes after the caller was away. Omit →
   * a resumed call is silent.
   */
  resumed?: LiveResumedSpec;
  /**
   * Trims the session's context once it grows past the trigger.
   *
   * @remarks Context window compression. Omit → none: the provider ends the session at its limit.
   */
  contextCompression?: LiveContextCompressionSpec;
  /** Text transcripts of the session's speech. */
  transcription?: LiveTranscriptionSpec;
}

/** How a profile's reply streams. */
export interface ProfileStreamingSpec {
  /** Whether the reply reaches the host as the model writes it, or whole. */
  mode?: StreamMode;
  /**
   * Whether the model's thinking reaches the host.
   *
   * @remarks When false, filter `thought` events from the turn stream.
   */
  streamThoughts?: boolean;
}

export type {
  MediaTurnBehaviourSpec,
  ProfileTurnBehaviourSpec,
  ProfileTurnResumptionSpec,
  TurnContinueFrom,
  TurnStop,
} from './stop.ts';

import type { LabelOverrides } from '../guardrails/labels.ts';
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
  providerContinuation?: ProviderContinuationPolicy;
  /** Host-named models. Each key is a selectable model id when `allowModelSelect` is set. */
  models: Record<ModelId, ModelBinding>;
  /** The model a turn runs when it names none; registration fills it with the only key when there is one. */
  defaultModel: ModelId;
  /** Turn may pass `{ model: "<id>" }`; a name that is not a key of `models` is refused. */
  allowModelSelect?: boolean;
  /** Tool-loop ceiling. Omit = `DEFAULT_MAX_STEPS`; `1` = one-shot; `> 1` = hard cap. */
  maxSteps?: number;
}

/** One value an option can take. `description` is what a picker shows beside it. */
export interface OptionChoice {
  /**
   * The value the code sets, which `when` reads and {name} prints.
   *
   * @catalog inputs.options.*.choices.*.value The value the turn sends for this choice, which
   * `when` reads and {name} prints.
   */
  value: string;
  /**
   * What this value means. It is never sent to the model.
   *
   * @catalog inputs.options.*.choices.*.description Visitor-facing blurb for this choice in the
   * composer. Never substituted into prompts.
   */
  description?: string;
}

/** One named option: its `label` for a picker, and the values it can take. */
export interface OptionDecl {
  /**
   * A person-readable title. Omit to show the option's name.
   *
   * @catalog inputs.options.*.label Visitor-facing title for this option in the composer (for
   * example Source Bias). Omit to show the option's name.
   */
  label?: string;
  /**
   * The values this option can take.
   *
   * @catalog inputs.options.*.choices The values this option can take, each with an optional UI
   * description.
   */
  choices: OptionChoice[];
}

/** A profile's options by name. Which object holds them says who drives them. */
export type ProfileOptions = Readonly<Record<string, OptionDecl>>;

/** What a profile accepts as input. */
export interface ProfileInputsSpec {
  /** Whether a turn may send text. */
  text?: boolean;
  /** Lets turns send files. */
  attachments?: {
    /**
     * The file types a turn may send, where type/* matches a whole family; image profiles take only
     * images, video, and PDF.
     */
    accept: string[];
  };
  /** Lets turns send voice clips. A transcription profile must set it. */
  voice?: {
    /** The audio types a voice clip may be; audio/* matches them all. */ accept: string[];
  };
  /** The most files and voice clips one turn or embedding request may send, counted together. */
  maxFiles?: number;
  /** The largest file or clip, in bytes, a turn or embedding request may send inline. */
  maxBytes?: number;
  /**
   * The most bytes one turn or embedding request may send inline across all its files and clips.
   */
  maxTurnBytes?: number;
  /**
   * Size limits by file type that replace maxBytes for those types.
   *
   * @catalog inputs.limitsByMime.* The largest file of this type (or type/* family), in bytes, a turn or embedding request may send inline.
   */
  limitsByMime?: Record<string, number>;
  /**
   * The options a person picks, each shown as a picker. A prompt reads one as "when reader is
   * student: …" and prints it as {reader}.
   *
   * @remarks The options a person picks: a host shows each one as a picker.
   * @catalog inputs.options.* { label?, choices: { value, description? }[] }. Value is what the turn sends and what {name} prints.
   */
  options?: ProfileOptions;
  /**
   * Lets the page or the host send the agent one package of things to know, read at the context
   * boundary.
   */
  context?: ProfileContextSpec;
}

/** What a live profile declares beside its ingress channels. */
export type LiveInputsSpec = Pick<ProfileInputsSpec, 'options' | 'context'>;

/** Who may send a turn its context, and how much. */
export interface ProfileContextSpec {
  /** Who may send context; context from anyone else is refused. */
  from: ContextSender[];
  /** The longest package, in characters of its JSON, each sender may send. */
  maxChars: number;
}

/** The context each sender gives a turn: any JSON, or text. */
export type TurnContext = Partial<Record<ContextSender, unknown>>;

/** What a profile returns: its structured schema, validation, and streaming. */
export interface ProfileOutputsSpec {
  /**
   * The registered JSON schema the reply must follow, which can vary by option; register it before
   * the profile.
   */
  structured?: StructuredSchemaId | StructuredByOption | null;
  /** Your checks on a structured reply, and how many rewrites a failure gets. */
  validation?: ProfileValidationSpec;
  /** How the reply reaches the host, and whether its thinking does. */
  streaming?: ProfileStreamingSpec;
}

/** Text a reply may not repeat when the rest of its prompt is marked shareable. */
export interface PrivateSystemPart {
  private: string;
}

/** One part of a system prompt: shareable text, or private text a reply may not repeat. */
export type SystemPart = string | PrivateSystemPart;

/**
 * A system prompt: a string, or parts sent concatenated as written. A string,
 * or parts none of which is `{ private }`, is private throughout; once one
 * part is `{ private }`, the plain strings beside it are shareable.
 */
export type SystemPrompt = string | readonly SystemPart[];

/** One line of a profile's prompt: text, or parts kept together. A leading `when` decides it. */
export type SystemLine = string | readonly SystemPart[];

/** A profile's prompt: a string, or lines. Every line that fits is sent, a blank line apart. */
export type ProfileSystem = string | readonly SystemLine[];

/** A stretch of the system prompt as sent, and whether a reply may repeat it. */
export interface SystemPiece {
  text: string;
  private: boolean;
}

/** A profile's handle and system prompt. */
export interface ProfileIdentity {
  /**
   * The name hosts and users see for this agent, at most 32 characters; the model never sees it.
   */
  handle: string;
  /**
   * The options the host's code sets on runTurn, which a person never sees. A line of
   * identity.system reads one as "when plan is free: …" and prints it as {plan}. One named path
   * holds the turn's path.
   *
   * @remarks The options the host's code states. A person never sees them.
   * @catalog identity.options.* { label?, choices: { value, description? }[] }, the same shape as inputs.options.*.
   */
  options?: ProfileOptions;
  /**
   * The instruction the model gets, as one string or a list of lines; some providers send it for an
   * image profile only with includeText on. A line that opens "when plan is free: …" goes only on
   * turns where that fits, and every line that fits is sent, a blank line apart. A line can be a
   * list of parts; mark what must not leak as { private: text }; only that is guarded. With none,
   * the whole prompt is.
   */
  system?: ProfileSystem;
}

/** The fields every profile type shares. */
export interface ProfileCommon {
  providerContinuation?: ProviderContinuationPolicy;
  id: ProfileId;
  identity: ProfileIdentity;
  models: Record<ModelId, ModelBinding>;
  defaultModel: ModelId;
  allowModelSelect?: boolean;
  maxSteps?: number;

  outputs?: ProfileOutputsSpec;
  guardrails?: ProfileGuardrailsSpec;
  observability?: ProfileObservabilitySpec;
  /** This profile's wording: replaces any label default, and any `overrideLabels` entry, for this profile. */
  labels?: LabelOverrides;
}

/** Any JSON value; the state a decision reads. */
export type DecisionJson =
  | null
  | string
  | number
  | boolean
  | DecisionJson[]
  | { [key: string]: DecisionJson };

/** What a decision profile accepts: JSON state up to a byte cap. */
export interface DecisionInputsSpec {
  /** A decision reads JSON state, passed on each call. */
  state: 'json';
  /**
   * The largest state, in bytes, a decision call may send; larger state is refused before it leaves
   * your process.
   */
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
  inputs: DecisionInputsSpec;
  decision: {
    /**
     * Your name for this decision, on its traces. Not sent to the model. Not checked against the
     * questions.
     */
    contract: DecisionContractId;
  };
  guardrails?: DecisionGuardrailsSpec;
  observability?: ProfileObservabilitySpec;
  /** This profile's wording: replaces any label default, and any `overrideLabels` entry, for this profile. */
  labels?: LabelOverrides;
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

/** A question answered with the one box that holds what the instructions name, in an image. */
export interface DecisionBoxQuestion {
  type: 'box';
  instructions: DecisionEntry;
  /**
   * The image the box is in: a reference in `assets`, such as `<ghs02>`, or the state field that
   * holds one, such as `photo.front`. Unset, the model reads the image from the instructions.
   */
  image?: string;
}

/** One question a decision answers. */
export type DecisionQuestion =
  | DecisionChoiceQuestion
  | DecisionNoulQuestion
  | DecisionScoreQuestion
  | DecisionBoxQuestion;

/** An image a decision reads: PNG or JPEG bytes as base64, with no `data:` prefix. */
export interface DecisionAsset {
  mimeType: 'image/png' | 'image/jpeg';
  data: string;
}

/** A request to `runDecision`: the profile, the state to judge, and the questions to answer. */
export interface DecisionRequest extends RunControls {
  profile: ProfileId;
  state: Exclude<DecisionJson, null>;
  questions: Record<string, DecisionQuestion>;
  /**
   * Images by reference. Write a reference in a string where its image belongs, in `state`, in a
   * question's instructions, or in its criteria, as the whole string or inside it; the model reads
   * the image in its place, once for each use. Keys are never read. Only the images some string
   * references are sent, so pick references that cannot occur in your text by accident.
   */
  assets?: Record<string, DecisionAsset>;
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
    }
  /** Edges are fractions of the image, from its top-left corner. */
  | {
      type: 'box';
      box: { top: number; bottom: number; left: number; right: number };
      confidence: number;
    };

/** What `runDecision` returns: the model and an answer for each question. */
export interface DecisionResult {
  model: string;
  answers: Record<string, DecisionAnswer>;
  /** Provider-reported tokens and cost; a cost worked out from the provider's prices is `estimated`. */
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number; estimated?: true };
}

/** One provider-neutral input part for an embedding request. */
export type EmbeddingPart =
  | { type: 'text'; text: string }
  | { type: 'media'; mimeType: string; data: string }
  | { type: 'media-ref'; mimeType: string; uri: string };

/** One embedding input. Media-only inputs remain valid for native local models. */
export type EmbeddingInput = string | { parts: readonly EmbeddingPart[] };

/** A profile's accepted embedding input kinds and limits. */
export interface EmbeddingInputsSpec {
  /** Whether a turn may send text. */
  text?: boolean;
  /** Lets turns send files. */
  attachments?: {
    /**
     * The file types a turn may send, where type/* matches a whole family; image profiles take only
     * images, video, and PDF.
     */
    accept: string[];
  };
  /** The most files and voice clips one turn or embedding request may send, counted together. */
  maxFiles?: number;
  /** The largest file or clip, in bytes, a turn or embedding request may send inline. */
  maxBytes?: number;
  /**
   * The most bytes one turn or embedding request may send inline across all its files and clips.
   */
  maxTurnBytes?: number;
  /**
   * Size limits by file type that replace maxBytes for those types.
   *
   * @catalog inputs.limitsByMime.* The largest file of this type (or type/* family), in bytes, a turn or embedding request may send inline.
   */
  limitsByMime?: Record<string, number>;
}

/** A profile that returns vectors instead of a model turn. */
export interface EmbeddingProfile extends Omit<ProfileCommon, 'identity' | 'outputs' | 'maxSteps'> {
  type: 'embedding';
  identity: Pick<ProfileIdentity, 'handle'>;
  inputs: EmbeddingInputsSpec;
}

/**
 * What the inputs are for in a search: `query` for what someone asks,
 * `document` for what is searched. A model that embeds the two the same way
 * ignores it.
 */
export type EmbeddingTask = 'query' | 'document';

/** A request to `runEmbedding`. */
export interface EmbeddingRequest extends RunControls {
  profile: ProfileId;
  model?: ModelId;
  input: EmbeddingInput | readonly EmbeddingInput[];
  task?: EmbeddingTask;
}

/** One vector returned for one ordered embedding input. */
export interface EmbeddingVector {
  index: number;
  values: readonly number[];
  dimensions: number;
}

/** Provider usage for an embedding call. */
export interface EmbeddingUsage {
  inputTokens?: number;
  costUsd?: number;
  estimated?: true;
}

/** The normalized result of `runEmbedding`. */
export interface EmbeddingResult {
  model: string;
  embeddings: readonly EmbeddingVector[];
  usage?: EmbeddingUsage;
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

/** A transcription profile's inputs: voice clips within byte limits, and no text. */
export type TranscriptionInputsSpec = Required<Pick<ProfileInputsSpec, 'voice'>> &
  Pick<ProfileInputsSpec, 'maxFiles' | 'maxBytes' | 'maxTurnBytes' | 'limitsByMime'>;

/**
 * Speech to text: a voice clip in, what was said out as the turn's text. No tools, no system
 * prompt, and no canary, because the model follows no instruction and has nothing of the profile's to leak.
 */
export interface TranscriptionProfile
  extends Omit<ProfileCommon, 'identity' | 'outputs' | 'maxSteps'> {
  type: 'transcription';
  identity: Pick<ProfileIdentity, 'handle'>;
  inputs: TranscriptionInputsSpec & { text: false };
  outputs?: undefined;
  maxSteps?: undefined;
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
 * `tools.allow` with no visibility, loading tiers, or path gating. `guardrails` holds only
 * the guards that fire on `invokeTool`: quota, canary, and egress guard a model turn, so
 * `defineProfile` refuses them rather than accept inert config.
 */
export interface HostProfile {
  type: 'host';
  id: ProfileId;
  tools: HostProfileToolsSpec;
  guardrails?: HostGuardrailsSpec;
  observability?: ProfileObservabilitySpec;
  /** This profile's wording: replaces any label default, and any `overrideLabels` entry, for this profile. */
  labels?: LabelOverrides;
}

/** The contract that defines an agent’s capabilities and the rules for its interactions. Its type determines which settings it accepts. */
export type Profile =
  | TextProfile
  | ImageProfile
  | SpeechProfile
  | TranscriptionProfile
  | LiveProfile
  | DecisionProfile
  | EmbeddingProfile
  | HostProfile;

/** Profiles that run a model turn — every type except `host` and `decision` (which runs through `runDecision`). */
export type ModelProfile = Exclude<Profile, HostProfile | DecisionProfile | EmbeddingProfile>;

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

/** What the user sent for a turn: text, options, attachments, voice, and history. */
export interface TurnInput {
  /** The user's message. */
  text?: string;
  /**
   * The value a person picked for each option in the profile's inputs.options; an option or a value
   * the profile does not declare is refused.
   *
   * @remarks The value picked for each of the profile's `inputs.options`.
   */
  options?: Readonly<Record<string, string>>;
  /**
   * What the page (client) or the host (server) wants the model to know, as any JSON or text; a
   * sender the profile's inputs.context does not list, or a package over its maxChars, is refused.
   *
   * @remarks What the page or the host wants the model to know, by sender; the profile's
   * `inputs.context` allows it.
   */
  context?: TurnContext;
  /**
   * Files sent with the turn, as bytes or as a provider file reference; each must pass the
   * profile's inputs.attachments.
   */
  attachments?: Array<TurnBlob | TurnMediaRef>;
  /** Recorded speech sent with the turn; each must pass the profile's inputs.voice. */
  voice?: TurnBlob[];
  /** The earlier messages of the conversation, when the host keeps them. */
  history?: TurnHistoryMessage[];
  /**
   * Background tool calls that settled after their turn, as the host stored them. The model reads
   * each as a tool result, and this reply counts it as a remote read when the call was remote. Pass
   * each one once: the turn emits it as a late_results event, so a history built from events holds
   * it.
   *
   * @remarks Tool calls that settled after their turn, as the host stored them. Each counts as read
   * in this reply.
   */
  lateResults?: ToolOperationOutcome[];
  /** A reply your host rejected and why, so that the model writes it again. */
  repair?: TurnRepairRequest;
  /**
   * Your count of the history's tokens, used by compaction that meters history.
   *
   * @remarks Optional host-supplied history token count for `meter: 'history'`. When set, overrides
   * the local history estimate. Not full-prompt API tokens.
   */
  historyTokens?: number;
  /**
   * Your count of the whole prompt's tokens, used by compaction that meters input before the call.
   *
   * @remarks Optional host-supplied full-prompt input token count for `meter: 'input'` with
   * `timing: 'before'` (typically the previous turn's `tokens.input`). Ignored when `meter` is
   * `'history'`.
   */
  inputTokens?: number;
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

/** What `runTurn` and `runSession` both take: an agent's profile, its model, and the host's hooks and keys. */
export interface AgentRunRequest extends RunControls, ModelChoice {
  /**
   * Host-owned atomic tool claims and outcomes. Never sent to providers. A throw before the call
   * runs fails the call. A throw after it ran keeps the result, marks the call uncertain and is
   * reported as hook_failed. A TheoremError is its answer and ends the turn.
   */
  execution?: ToolExecutionCoordinator;
  /**
   * Host-issued service for tool calls that go on after their reply. It needs a coordinator with
   * detach. Without it every tool runs inline. A throw from its event goes on the call's own trace.
   */
  background?: ToolBackgroundService;
  /** Host-issued browser dispatch with a claimed operation and correlated result. */
  pageExecution?: PageToolExecution;
  /** Native provider state saved alongside portable history. */
  providerState?: ProviderCheckpoint;
  /** The id of the registered profile the turn or session runs. */
  profile: ProfileId;
  /**
   * Args for the provider's own tools on the chosen model's builtInTools, by tool id; each is
   * checked by the schema the provider declares for that tool.
   *
   * @remarks Args for built-in tools on the chosen model's `builtInTools`, by tool id. Each is
   * parsed by the schema the provider's adapter declares for that tool.
   */
  builtInArgs?: BuiltInArgs;
  /**
   * An instruction for this request only, added to the profile's own.
   *
   * @remarks Host-provided dynamic system prompt combined with profile persona
   */
  system?: SystemPrompt;
  /** The tools the user has already approved for this session. */
  sessionPermissions?: string[];
  /**
   * The channel the turn or session comes from; only tools whose paths name it, or *, are offered.
   *
   * @remarks Host channel/path for catalog `paths` filtering.
   */
  path?: string;
  /**
   * The value the host's code sets for each option in the profile's identity.options but path; an
   * option or a value the profile does not declare is refused.
   *
   * @remarks This run's value for each of `profile.identity.options` it sets; `path` is the run's
   * own.
   */
  options?: Readonly<Record<string, string>>;
  /**
   * Your own context, handed to tool handlers as ctx.host; Theorem never reads or records it.
   *
   * @remarks Opaque application context handed to tool `handler` / `preTool` and `tools.t1Policy`
   * as `ctx.host`. The kernel never reads, logs, traces, or serializes it.
   */
  host?: unknown;
  /**
   * Where an HTTP or MCP tool gets the credential for its auth slot.
   *
   * @remarks Credentials for authenticated HTTP / MCP tools, read by auth slot when a tool needs
   * one.
   */
  credentials?: ToolCredentialSource;
  /**
   * Resolves the host name of a remote tool before each request; a name that resolves to a private
   * address is refused.
   *
   * @remarks Resolves remote tool and OAuth host names before each request; a name that resolves to
   * a private address is refused (see `fetchGuarded`).
   */
  resolveHost?: ResolveHost;
  /**
   * Sends each request a remote tool makes, once that request's network checks pass. A page whose
   * tools cannot reach a host directly sends them through its own server here.
   *
   * @remarks Sends each request a remote tool makes (HTTP, MCP, a signed-in fetch, an image read),
   * once that request's network checks pass. A page whose tools cannot reach a host directly sends
   * them through its own server here. Default: the global `fetch`.
   */
  fetch?: typeof fetch;
  /**
   * Your function that sees each stage of a text turn or a live session, and can answer with what
   * the stage allows. A throw at pre_tool fails that call. A throw at any other stage is reported as
   * hook_failed, and the turn goes on without its answer.
   *
   * @remarks Text `runTurn` and `runSession` emit stages and apply the returned affordances. A
   * session's is set once.
   */
  onStage?: StageHandler;
  /**
   * Runs before each agent tool call, to shape the request to the called agent or to refuse the
   * call.
   *
   * @remarks Runs before each agent tool call in this run, and in the turns those calls run. Shape
   * the called agent's request (history, model, provider) or refuse the call. Omit it: the agent
   * runs on what the model sent.
   */
  onAgentCall?: AgentCallHook;
}

/** A request to `runTurn`: the shared controls and the turn's input. */
export interface TurnRequest extends AgentRunRequest {
  /**
   * A session key that OpenRouter uses for routing and caching.
   *
   * @remarks Sticky routing / cache session key for OpenRouter (`session_id`). Not the same as
   * `projectId` or Gemini `previousInteractionId`.
   */
  sessionId?: string;
  /**
   * This turn's voice, style, and speed; each one given replaces the profile's speech field of that
   * name. Refused on a profile that is not speech.
   *
   * @remarks This turn's voice, style, and speed, over `profile.speech`. Speech profiles only.
   */
  speech?: TurnSpeech;
  /**
   * Continues a turn that stopped in a way the profile lets a turn continue.
   *
   * @remarks Continue a prior resumeable stop. On text profiles the turn's user message is the
   * continue instruction (no `input.text`); the host passes the partial reply as the last assistant
   * message in `input.history`. Image and speech re-send the original request unchanged.
   */
  continueFrom?: TurnContinueFrom;
  /**
   * Which continue attempt this is, from 1; checked against the maxContinues of the profile.
   *
   * @remarks 1-based continue attempt when `continueFrom` is set. Compared to
   * `profile.turnBehaviour.resumption.maxContinues` when that cap is set.
   */
  continuation?: number;
  /**
   * Tools this reply already had when an earlier run of it paused; the turn opens with them on its
   * list.
   *
   * @remarks Tools this reply already had when an earlier run of it paused. The turn opens with
   * them on its list, so an answered call does not take back what the model loaded. An id
   * `tools.allow` or the path does not grant is left out, as for `tools.t1Policy`.
   */
  promoted?: ToolId[];
  /**
   * Steps this reply already took when an earlier run of it paused; they count against maxSteps.
   *
   * @remarks Steps this reply already took when an earlier run of it paused. They count against
   * `maxSteps`, so an answered call does not give the reply its steps back. Read `done.steps`.
   */
  stepsTaken?: number;
  /**
   * Reads each of the turn's events as it leaves runTurn, before the caller gets it. A throw goes
   * to the caller as hook_failed, which this function does not read, and the turn goes on.
   *
   * @remarks Reads each of this turn's events as it leaves `runTurn`, before the caller gets it.
   * The app sets it in `TurnWiring.prepare` to act on a turn someone else runs, such as saving the
   * reply when `done` arrives. A throw is reported to the caller as `hook_failed`, and the turn
   * goes on. `invokeTool` does not call it.
   */
  onEvent?: (event: TurnEvent) => void | Promise<void>;
  /**
   * Set on the turn TurnWiring.prepare is given for a held call that goes on once answered: no
   * model runs, and input is the paused turn's.
   *
   * @remarks Set on the turn `TurnWiring.prepare` is given for a held call that goes on once
   * answered. No model runs and `input` is the paused turn's, so it is not a new message.
   */
  answersHeldCall?: true;
  /** What the user sent for the turn. */
  input?: TurnInput;
}

/**
 * How an application runs its turns: the one value its own call sites, its web handler and the
 * studio all use, so they cannot run a turn differently. An app that calls `runTurn` itself
 * writes `runTurn(await wiring.prepare(turn), wiring.provider)`.
 */
export interface TurnWiring {
  /** Registers the application's profiles and tools. Called once, before the first turn. */
  register?: () => void | Promise<void>;
  /** The keys, network and limits each model call runs on. */
  provider?: ProviderHostOptions;
  /**
   * The turn the application runs, from the one it is given: the profile, the input with the
   * conversation's history, and the application's context as `host`. Set what the application
   * sets per turn, such as `system`, `credentials`, `onStage`, `onEvent`, `onAgentCall`, `path`
   * and `metadata`. Text, image and speech turns run through it.
   */
  prepare?: (turn: NormalizedTurnRequest) => TurnRequest | Promise<TurnRequest>;
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
  /** Forwarded as OpenRouter `session_id`. */
  sessionId?: string;
}

/** The transport a provider adapter speaks. */
export type ProviderTransport = 'turn' | 'live';

/** A generation config after the profile and request are resolved, with its transport. */
export interface ResolvedGeneration extends ProviderGenerationConfig {
  /** The request's `builtInArgs`, parsed. */
  builtInArgs?: BuiltInArgs;
  execution?: ToolExecutionCoordinator;
  pageExecution?: PageToolExecution;
  transport: ProviderTransport;
  /** The protocol's `gen_ai.operation.name` for this profile type; absent when no provider is registered for the binding. */
  operationName?: string;
  tools: TurnToolSnapshot;
  sessionPermissions?: string[];
  history?: TurnHistoryMessage[];
  /** Tool-loop ceiling: the profile's `maxSteps`, or `DEFAULT_MAX_STEPS`. */
  maxSteps?: number;
  structured: ResolvedStructured | null;
  image: ImageResponseFormat | null;
  speech?: ProfileSpeechSpec;
  live?: ProfileLiveSpec;
  input: InteractionPart[];
  /**
   * The canary bound into the system prompt; empty with the canary off. A turn
   * binds the profile's (`profileCanary`), the same for the same prompt; a
   * Live session binds this one, minted for it.
   */
  canary: string;
  /** Snapshotted synchronously before any async work; the runner binds the canary on top. */
  resolvedSystem: readonly SystemPiece[];
  /** Which of the profile's prompt lines fit this turn, by number from 1. */
  systemLines: readonly number[];
  /** `TurnRequest.host`, carried to tool contexts only. Never sent to providers or traces. */
  host?: unknown;
}

/** One model call as the engine asks it: the resolved generation, the conversation, and the tools. */
export interface ModelRequest extends Omit<ProviderGenerationConfig, 'summaries' | 'builtins'> {
  /** The turn's builtins with the args addressed to each. */
  builtins: ProviderBuiltin[];
  summaries?: SummaryMode;
  providerState?: ProviderCheckpoint;
  system: string;
  input: InteractionPart[];
  history?: TurnHistoryMessage[];
  wireTools?: WireFunctionTool[];
  structured: ResolvedStructured | null;
  image: ImageResponseFormat | null;
  speech?: ProfileSpeechSpec;
  live?: ProfileLiveSpec;
  /** Live: the fenced context the session opens with, seeded after `history` so it lands before any input. */
  context?: string[];
  /** Scrubbed SSE / HTTP rows for traces. */
  tapUpstream?: (row: Record<string, unknown>) => void;
  /** Host abort signal. */
  signal?: AbortSignal;
}

/** One model call, streamed as the model's events. */
export interface TurnModel {
  complete: (req: ModelRequest) => AsyncIterable<ModelEvent>;
}

/**
 * Host request to open a long-lived live session (`runSession`).
 * Profile must be `type: 'live'`.
 */
export interface SessionRequest extends AgentRunRequest {
  /** Override `profile.live.voice` for this session. */
  voice?: string;
  history?: TurnHistoryMessage[];
  /** The value picked for each of the profile's `inputs.options`. */
  inputOptions?: Record<string, string>;
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
}

/**
 * Run a call the model made in this session, by its id: once, with the
 * model's input. `decision` answers a call waiting on a gate, and only such a
 * call; `input` is the user's edit, and only with `approve` on a gated call.
 */
export type LiveExecuteToolArgs = {
  callId: string;
  operationId?: string;
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
 * Open live session returned by `runSession`. It streams events until
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
