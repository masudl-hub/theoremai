/**
 * Runtime vocabulary and field catalog for THEORUM profile types.
 *
 * Closed unions live here as `as const` arrays; TypeScript types are derived
 * from those arrays. Host UIs and docs import this module (no Deno APIs) so
 * dropdowns and hover tips stay in lockstep with the kernel.
 *
 * @module
 */

import { GOOGLE_SPEECH_VOICES } from '../presets/google/speech-voices.ts';

/** Model reasoning effort level normalized across provider adapters. */
export const THINKING_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Wire protocol for a profile. */
export const PROTOCOLS = ['geminiInteractions', 'geminiLive', 'openAi'] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/** Transport provider for a profile. */
export const PROVIDERS = ['google', 'openrouter', 'local'] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * Legal `createProvider` pairs. Keep this table in lockstep with the factory.
 * Keys are protocols; values are the providers that protocol may bind.
 */
export const PROTOCOL_PROVIDERS = {
  geminiInteractions: ['google'],
  geminiLive: ['google'],
  openAi: ['openrouter', 'local'],
} as const satisfies Record<Protocol, readonly Provider[]>;

/** Named Gemini key bucket used by host-provided transports. */
export const GEMINI_BUCKETS = ['freeA', 'freeB', 'freeC', 'paid'] as const;
export type GeminiBucket = (typeof GEMINI_BUCKETS)[number];

/** Gemini bucket that may overflow to the paid bucket after quota backoff. */
export const GEMINI_FREE_BUCKETS = ['freeA', 'freeB', 'freeC'] as const satisfies readonly Exclude<
  GeminiBucket,
  'paid'
>[];
export type GeminiFreeBucket = (typeof GEMINI_FREE_BUCKETS)[number];

/** Profile-level control a caller may toggle at turn time. */
export const CONTROL_IDS = ['thinking'] as const;
export type ControlId = (typeof CONTROL_IDS)[number];

/** Normalized multimodal part category. */
export const MEDIA_INPUT_KIND_VALUES = ['image', 'audio', 'video', 'document'] as const;
export type MediaInputKind = (typeof MEDIA_INPUT_KIND_VALUES)[number];

/** Provider thinking-summary behavior. */
export const SUMMARY_MODES = ['auto', 'none'] as const;
export type SummaryMode = (typeof SUMMARY_MODES)[number];

/** Stream delivery mode. */
export const STREAM_MODES = ['sse', 'buffered'] as const;
export type StreamMode = (typeof STREAM_MODES)[number];

/** Audio container for speech generation output. */
export const SPEECH_AUDIO_FORMATS = ['pcm', 'mp3'] as const;
export type SpeechAudioFormat = (typeof SPEECH_AUDIO_FORMATS)[number];

/** Live session activity handling (barge-in behavior). */
export const LIVE_ACTIVITY_HANDLINGS = ['START_OF_ACTIVITY_INTERRUPTS', 'NO_INTERRUPTION'] as const;
export type LiveActivityHandling = (typeof LIVE_ACTIVITY_HANDLINGS)[number];

/** Live session voice activity detection sensitivity. */
export const LIVE_SPEECH_SENSITIVITIES = [
  'START_SENSITIVITY_LOW',
  'START_SENSITIVITY_HIGH',
  'END_SENSITIVITY_LOW',
  'END_SENSITIVITY_HIGH',
] as const;
export type LiveSpeechSensitivity = (typeof LIVE_SPEECH_SENSITIVITIES)[number];

/** Live session context window compression mode. */
export const LIVE_CONTEXT_COMPRESSIONS = ['slidingWindow', 'none'] as const;
export type LiveContextCompression = (typeof LIVE_CONTEXT_COMPRESSIONS)[number];

/** Structured-output enforcement mode. */
export const SCHEMA_ENFORCEMENTS = ['responseFormat', 'prompt'] as const;
export type SchemaEnforcement = (typeof SCHEMA_ENFORCEMENTS)[number];

/** Compaction threshold meter. */
export const COMPACTION_METERS = ['history', 'input'] as const;
export type CompactionMeter = (typeof COMPACTION_METERS)[number];

/** When compaction runs relative to the primary turn. */
export const COMPACTION_TIMINGS = ['before', 'after'] as const;
export type CompactionTiming = (typeof COMPACTION_TIMINGS)[number];

/** Egress block handling. */
export const EGRESS_ON_BLOCK = ['reject_to_agent', 'refuse_to_user'] as const;
export type EgressOnBlock = (typeof EGRESS_ON_BLOCK)[number];

/** Why a turn ended (provider-neutral). */
export const TURN_STOP_KINDS = [
  'completed',
  'length',
  'tool',
  'filtered',
  'provider_error',
  'cancelled',
  'stream_incomplete',
  'interrupted',
] as const;
export type TurnStopKind = (typeof TURN_STOP_KINDS)[number];

/** Per-tool visibility tier — enforced by the kernel at resolve time. */
export const TOOL_LOAD_TIERS = ['T0', 'T1', 'T2'] as const;
export type ToolLoadTier = (typeof TOOL_LOAD_TIERS)[number];

/** Registered tool discriminant (`registerTool`). */
export const TOOL_TYPES = ['builtin', 'function'] as const;

/** Semantic access level — host policy / UI; not enforced by execute. */
export const TOOL_ACCESS = ['read-only', 'read-write', 'destructive'] as const;
export type ToolAccess = (typeof TOOL_ACCESS)[number];

/** Execution authorization tier for registered tools. */
export const TOOL_PERMISSION = ['auto', 'session_consent', 'always_confirm'] as const;
export type ToolPermission = (typeof TOOL_PERMISSION)[number];

/** MIME essence → normalized media part category (shared ingress map). */
export const MEDIA_INPUT_KINDS: Record<string, MediaInputKind> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/webp': 'image',
  'image/heic': 'image',
  'image/heif': 'image',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/mpeg': 'audio',
  'audio/mp3': 'audio',
  'audio/aiff': 'audio',
  'audio/aac': 'audio',
  'audio/ogg': 'audio',
  'audio/flac': 'audio',
  'audio/webm': 'audio',
  'audio/mp4': 'audio',
  'audio/pcm': 'audio',
  'video/mp4': 'video',
  'video/mpeg': 'video',
  'video/quicktime': 'video',
  'video/x-msvideo': 'video',
  'video/x-flv': 'video',
  'video/mpg': 'video',
  'video/webm': 'video',
  'video/wmv': 'video',
  'video/x-ms-wmv': 'video',
  'video/3gpp': 'video',
  'application/pdf': 'document',
  'text/plain': 'document',
  'text/csv': 'document',
  'text/markdown': 'document',
  'text/html': 'document',
  'application/json': 'document',
};

/** Type-prefix wildcards accepted by `mimeAllowed`. */
export const MEDIA_WILDCARDS = ['image/*', 'audio/*', 'video/*'] as const;

function mimesOf(kind: MediaInputKind): string[] {
  return Object.keys(MEDIA_INPUT_KINDS).filter((mime) => MEDIA_INPUT_KINDS[mime] === kind);
}

/** Attachment `accept` values the kernel can classify (wildcards + known types). */
export const ATTACHMENT_ACCEPT_MIMES: readonly string[] = [
  'image/*',
  'video/*',
  ...mimesOf('image'),
  ...mimesOf('video'),
  ...mimesOf('document'),
];

/** Voice `accept` values the kernel can classify (wildcard + known audio types). */
export const VOICE_ACCEPT_MIMES: readonly string[] = ['audio/*', ...mimesOf('audio')];

/** Providers allowed for a protocol. */
export function providersFor(protocol: Protocol): readonly Provider[] {
  return PROTOCOL_PROVIDERS[protocol];
}

/** Protocols allowed for a provider. */
export function protocolsFor(provider: Provider): readonly Protocol[] {
  const found: Protocol[] = [];
  for (const protocol of PROTOCOLS) {
    if ((PROTOCOL_PROVIDERS[protocol] as readonly Provider[]).includes(provider)) {
      found.push(protocol);
    }
  }
  return found;
}

/** True when `createProvider` will accept this pair. */
export function isValidPair(protocol: Protocol, provider: Provider): boolean {
  return (PROTOCOL_PROVIDERS[protocol] as readonly Provider[]).includes(provider);
}

/** When protocol changes, snap provider to a valid partner. */
export function coerceProvider(protocol: Protocol, provider: Provider): Provider {
  const allowed = providersFor(protocol);
  const [first] = allowed;
  return allowed.includes(provider) ? provider : first;
}

/** When provider changes, snap protocol to a valid partner. */
export function coerceProtocol(protocol: Protocol, provider: Provider): Protocol {
  const allowed = protocolsFor(provider);
  const [first] = allowed;
  return allowed.includes(protocol) ? protocol : first;
}

function unionType(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(' | ');
}

/** Metadata for one profile (or adjacent) field, used by docs/UI hover. */
export type FieldMeta = {
  type: string;
  doc: string;
  options?: readonly string[];
  optionDescriptions?: Record<string, string>;
  optionNote?: string;
};

function field(
  type: string,
  doc: string,
  options?: readonly string[],
  optionDescriptionsOrNote?: Record<string, string> | string,
  optionNote?: string,
): FieldMeta {
  if (options) {
    if (typeof optionDescriptionsOrNote === 'object') {
      return optionNote
        ? { type, doc, options, optionDescriptions: optionDescriptionsOrNote, optionNote }
        : { type, doc, options, optionDescriptions: optionDescriptionsOrNote };
    }
    if (typeof optionDescriptionsOrNote === 'string') {
      return { type, doc, options, optionNote: optionDescriptionsOrNote };
    }
    return { type, doc, options };
  }
  return { type, doc };
}

/**
 * Parents whose next key is a host-owned map key (model id, slot name, …).
 * The annotator substitutes `*` so `model.config.flash.apiId` → `model.config.*.apiId`.
 */
export const DYNAMIC_FIELD_PARENTS: ReadonlySet<string> = new Set([
  'model.config',
  'model.select',
  'model.thinking',
  'identity.systemByRole',
  'inputs.slots',
  'inputs.limitsByMime',
  'outputs.validation.fields',
]);

/** Resolve a key stack from authored source into a catalog path. */
export function catalogPathFor(keys: readonly string[]): string {
  const resolved: string[] = [];
  for (const key of keys) {
    const prefix = resolved.join('.');
    if (DYNAMIC_FIELD_PARENTS.has(prefix)) {
      resolved.push('*');
    } else {
      resolved.push(key);
    }
  }
  return resolved.join('.');
}

/**
 * Authoring-surface catalog for `Profile` / `defineProfile`.
 * Hover UIs look up dotted paths. Adding a profile field? Add it here.
 */
export const PROFILE_FIELDS: Record<string, FieldMeta> = {
  id: field('string', 'Host-owned profile identifier.'),
  type: field("'text' | 'image' | 'speech' | 'live'", 'Required profile archetype.'),
  identity: field(
    '{ handle, system?, systemByRole? }',
    'Display handle and system instruction the model receives each turn.',
  ),
  'identity.handle': field('string', 'Public handle for this agent.'),
  'identity.system': field('string', 'System instruction merged into every turn.'),
  'identity.systemByRole': field(
    'Record<string, string>',
    'Optional system instruction keyed by turn role.',
  ),
  'identity.systemByRole.*': field(
    'string',
    'System instruction merged when this turn role is active.',
  ),
  model: field('ProfileModelSpec', 'Protocol, provider, allowlist, wire config, and step bounds.'),
  'model.protocol': field(
    unionType(PROTOCOLS),
    'Wire protocol. Pairs with provider via createProvider.',
    PROTOCOLS,
    {
      geminiInteractions: 'Google Gemini Interactions wire protocol (Gemini 2.5 / 3+).',
      openAi: 'OpenAI-compatible chat completions and streaming protocol.',
    },
  ),
  'model.provider': field(
    unionType(PROVIDERS),
    'Transport. Must form a legal pair with protocol.',
    PROVIDERS,
    {
      google: 'Direct Google Gemini API transport.',
      openrouter: 'OpenRouter multi-provider API proxy.',
      local: 'Local OpenAI-compatible server (Ollama, llama.cpp, vLLM).',
    },
  ),
  'model.allow': field('ModelId[]', 'Ids this profile may select. Each id must exist in config.'),
  'model.config': field(
    'Record<ModelId, ModelSpec>',
    'Host-owned wire config keyed by the same ids used in allow / select.',
  ),
  'model.config.*': field(
    'ModelSpec',
    'Host-owned wire config for this model id (apiId, thinking, token limits, compaction).',
  ),
  'model.config.*.apiId': field('string', 'Provider wire model id.'),
  'model.config.*.thinking': field(
    '{ on, off }',
    'Thinking levels used when a boolean thinking control is on or off.',
  ),
  'model.config.*.thinking.on': field(
    unionType(THINKING_LEVELS),
    'Level when thinking is on.',
    THINKING_LEVELS,
    {
      none: 'Disable reasoning tokens completely.',
      minimal: 'Minimal reasoning tokens for fastest response.',
      low: 'Low reasoning budget for basic structured tasks.',
      medium: 'Balanced reasoning for multi-step agent actions.',
      high: 'Deep reasoning for complex planning and code.',
      xhigh: 'Extended reasoning budget for hard problems.',
      max: 'Maximum reasoning tokens supported by model.',
    },
  ),
  'model.config.*.thinking.off': field(
    unionType(THINKING_LEVELS),
    'Level when thinking is off.',
    THINKING_LEVELS,
    {
      none: 'Disable reasoning tokens completely.',
      minimal: 'Minimal reasoning tokens for fastest response.',
      low: 'Low reasoning budget for basic structured tasks.',
      medium: 'Balanced reasoning for multi-step agent actions.',
      high: 'Deep reasoning for complex planning and code.',
      xhigh: 'Extended reasoning budget for hard problems.',
      max: 'Maximum reasoning tokens supported by model.',
    },
  ),
  'model.config.*.thinkingLevels': field(
    'ThinkingLevel[]',
    'Levels this model accepts. Illegal values are clamped.',
    THINKING_LEVELS,
    {
      none: 'Disable reasoning tokens completely.',
      minimal: 'Minimal reasoning tokens for fastest response.',
      low: 'Low reasoning budget for basic structured tasks.',
      medium: 'Balanced reasoning for multi-step agent actions.',
      high: 'Deep reasoning for complex planning and code.',
      xhigh: 'Extended reasoning budget for hard problems.',
      max: 'Maximum reasoning tokens supported by model.',
    },
  ),
  'model.config.*.summaries': field('{ on, off }', 'Summary behavior for the thinking control.'),
  'model.config.*.summaries.on': field(
    unionType(SUMMARY_MODES),
    'Summaries when thinking is on.',
    SUMMARY_MODES,
    {
      auto: 'Emit thinking summaries when available.',
      none: 'Suppress thinking summaries from the stream.',
    },
  ),
  'model.config.*.summaries.off': field(
    unionType(SUMMARY_MODES),
    'Summaries when thinking is off.',
    SUMMARY_MODES,
    {
      auto: 'Emit thinking summaries when available.',
      none: 'Suppress thinking summaries from the stream.',
    },
  ),
  'model.config.*.maxOutputTokens': field('number', 'Maximum tokens the model may emit.'),
  'model.config.*.temperature': field('number', 'Sampling temperature.'),
  'model.config.*.builtInTools': field(
    'BuiltinToolId[]',
    'Provider-native builtins enabled whenever this model is selected.',
  ),
  'model.config.*.key': field(
    unionType(GEMINI_BUCKETS),
    'Optional vault slot for this model. Overrides profile.model.key.',
    GEMINI_BUCKETS,
  ),
  'model.config.*.compaction': field(
    'CompactionSpec',
    'Optional compaction policy for this model.',
  ),
  'model.config.*.compaction.maxTokens': field(
    'number',
    'Token budget compared by the trigger (compactAt * maxTokens).',
  ),
  'model.config.*.compaction.compactAt': field(
    'number',
    'Fraction of maxTokens at which compaction fires. Must be in (0, 1).',
  ),
  'model.config.*.compaction.previousExchanges': field(
    'number',
    '≥ 1 = exchange count, (0, 1) = fraction of maxTokens, 0 = compact all.',
  ),
  'model.config.*.compaction.profile': field(
    'ProfileId',
    'Compaction agent profile id. Must be registered before the owning profile.',
  ),
  'model.config.*.compaction.timing': field(
    unionType(COMPACTION_TIMINGS),
    'When compaction runs relative to the primary turn.',
    COMPACTION_TIMINGS,
    {
      before: 'Compact synchronously before running the turn request.',
      after: 'Signal on done for host async background compaction.',
    },
  ),
  'model.config.*.compaction.meter': field(
    unionType(COMPACTION_METERS),
    'What the threshold meters. Defaults to history.',
    COMPACTION_METERS,
    {
      history: 'Meters token count across prior conversation turns.',
      input: 'Meters full turn input token count (system + history + attachments).',
    },
  ),
  'model.select': field(
    'Record<string, ModelId>',
    'Named aliases (fast / smart) → allowlisted ids.',
  ),
  'model.select.*': field('ModelId', 'Allowlisted model id for this select key.'),
  'model.thinking': field(
    'ThinkingLevel | Record<string, ThinkingLevel>',
    'Default thinking pin, or a map keyed by select labels.',
    THINKING_LEVELS,
    {
      none: 'Disable reasoning tokens completely.',
      minimal: 'Minimal reasoning tokens for fastest response.',
      low: 'Low reasoning budget for basic structured tasks.',
      medium: 'Balanced reasoning for multi-step agent actions.',
      high: 'Deep reasoning for complex planning and code.',
      xhigh: 'Extended reasoning budget for hard problems.',
      max: 'Maximum reasoning tokens supported by model.',
    },
  ),
  'model.thinking.*': field(
    unionType(THINKING_LEVELS),
    'Thinking pin for this select key.',
    THINKING_LEVELS,
    {
      none: 'Disable reasoning tokens completely.',
      minimal: 'Minimal reasoning tokens for fastest response.',
      low: 'Low reasoning budget for basic structured tasks.',
      medium: 'Balanced reasoning for multi-step agent actions.',
      high: 'Deep reasoning for complex planning and code.',
      xhigh: 'Extended reasoning budget for hard problems.',
      max: 'Maximum reasoning tokens supported by model.',
    },
  ),
  'model.controls': field('ControlId[]', 'Turn-time toggles this profile exposes.', CONTROL_IDS),
  'model.maxSteps': field(
    'number',
    'Tool-loop ceiling. <=0 unbounded, 1 one-shot, >1 ceiling. Omit → unbounded.',
  ),
  'model.key': field(
    unionType(GEMINI_FREE_BUCKETS),
    'Gemini vault slot for Google Interactions. Paid is overflow-only.',
    GEMINI_FREE_BUCKETS,
  ),
  tools: field(
    '{ allow: ToolId[]; t1Policy?; t2Loader? }',
    'Custom tools (allow), optional T1 policy, optional T2 loader function id. Builtins belong on model.config.*.builtInTools.',
  ),
  'tools.allow': field(
    'ToolId[]',
    'Custom tools the agent may call. Builtins are declared per model, not here.',
  ),
  'tools.t1Policy': field(
    '(ctx) => ToolId[] | Promise<ToolId[]>',
    'Optional T1 policy — which eligible loadTier:T1 tools to wire at turn start.',
  ),
  'tools.t2Loader': field(
    'ToolId',
    'Optional function tool id for T2 promotion. Must be in tools.allow; handler returns { loaded: string[] }.',
  ),
  inputs: field('ProfileInputsSpec', 'Text, attachment, voice, slot, and size rules.'),
  'inputs.text': field(
    'boolean',
    'Whether the profile accepts text on a turn. False rejects text.',
  ),
  'inputs.attachments': field('{ accept: string[] }', 'File upload allowlist.'),
  'inputs.attachments.accept': field(
    'string[]',
    'MIME allowlist for uploaded files. Type-prefix wildcards (image/*, …) are allowed.',
    ATTACHMENT_ACCEPT_MIMES,
    'Kernel-known types (plus wildcards). Hosts may list any MIME; unknown types are rejected at ingress.',
  ),
  'inputs.voice': field(
    '{ accept: string[] }',
    'Voice ingress block — not a bare string. Use accept for audio MIME allowlist.',
  ),
  'inputs.voice.accept': field(
    'string[]',
    'MIME allowlist for voice blobs. audio/* wildcards are allowed.',
    VOICE_ACCEPT_MIMES,
    'Kernel-known audio types (plus audio/*).',
  ),
  'inputs.maxFiles': field(
    'number',
    'Max files per turn. Required when attachments or voice is set.',
  ),
  'inputs.maxBytes': field(
    'number',
    'Max bytes per file. Required when attachments or voice is set.',
  ),
  'inputs.maxTurnBytes': field(
    'number',
    'Max total bytes per turn. Required when attachments or voice is set.',
  ),
  'inputs.limitsByMime': field('Record<string, number>', 'Optional per-MIME byte caps.'),
  'inputs.limitsByMime.*': field('number', 'Maximum byte limit for files of this MIME type.'),
  'inputs.slots': field(
    'Record<string, string[]>',
    'Optional turn-time selectors (e.g. language: ["html", "tsx"]).',
  ),
  'inputs.slots.*': field('string[]', 'Allowed choices for this turn selector.'),
  outputs: field('ProfileOutputsSpec', 'Structured, validation, and streaming output policy.'),
  'outputs.structured': field(
    'StructuredSchemaId | StructuredBySlot | null',
    'Registered schema id, slot-mapped ids, or null for free text.',
  ),
  image: field('ProfileImageSpec', 'Pins for an image-role profile. Model id is on model.'),
  'image.aspectRatio': field('string', 'Optional output aspect ratio. Omitted → provider default.'),
  'image.size': field('string', 'Optional output size / resolution. Omitted → provider default.'),
  'image.mimeType': field('string', 'Output MIME for generated images.'),
  'image.maxInputImages': field('number', 'Cap on reference images in one turn.'),
  'image.includeText': field(
    'boolean',
    'When true, request interleaved assistant text alongside generated images.',
  ),
  speech: field('ProfileSpeechSpec', 'TTS pins. Model id is on model.'),
  'speech.voice': field(
    'string',
    'TTS voice id. Kernel accepts any string; Google preset narrows to named voices.',
  ),
  'speech.format': field(
    unionType(SPEECH_AUDIO_FORMATS),
    'pcm (default) → WAV on both transports. mp3 requires protocol openAi.',
    SPEECH_AUDIO_FORMATS,
    {
      pcm: 'Raw 24kHz 16-bit PCM audio (→ WAV container). Supported by Google and OpenAI.',
      mp3: 'MP3 encoded stream. Requires openAi protocol.',
    },
  ),
  live: field('ProfileLiveSpec', 'Bidirectional live audio/video streaming session pins.'),
  'live.voice': field(
    'string',
    'TTS voice name for live audio output (e.g. Puck, Aoede, Charon).',
    GOOGLE_SPEECH_VOICES,
    'Google preset vocabulary; kernel accepts any string.',
  ),
  'live.vad': field(
    'LiveVadSpec',
    'Voice activity detection, barge-in, and endpointing sensitivity.',
  ),
  'live.vad.activityHandling': field(
    unionType(LIVE_ACTIVITY_HANDLINGS),
    'Barge-in handling when user speaks.',
    LIVE_ACTIVITY_HANDLINGS,
  ),
  'live.vad.startSensitivity': field(
    unionType(LIVE_SPEECH_SENSITIVITIES),
    'Sensitivity for detecting start of speech.',
    LIVE_SPEECH_SENSITIVITIES,
  ),
  'live.vad.endSensitivity': field(
    unionType(LIVE_SPEECH_SENSITIVITIES),
    'Sensitivity for detecting end of speech.',
    LIVE_SPEECH_SENSITIVITIES,
  ),
  'live.vad.prefixPaddingMs': field('number', 'Speech prefix buffer duration in ms.'),
  'live.vad.silenceDurationMs': field(
    'number',
    'Required silence before committing end-of-speech in ms.',
  ),
  'live.sessionResumption': field(
    'boolean',
    'Enable session resumption handles across WebSocket reconnects.',
  ),
  'live.contextCompression': field(
    unionType(LIVE_CONTEXT_COMPRESSIONS),
    'Context window compression mechanism.',
    LIVE_CONTEXT_COMPRESSIONS,
  ),
  'live.proactiveAudio': field(
    'boolean',
    'Allow model to reject responding or stay silent if unprompted.',
  ),
  'live.transcription': field(
    'LiveTranscriptionSpec',
    'Enable real-time input/output audio transcriptions.',
  ),
  'live.transcription.input': field('boolean', 'Transcribe user input speech.'),
  'live.transcription.output': field('boolean', 'Transcribe model output speech.'),
  'outputs.validation': field('ProfileValidationSpec', 'Host domain validators and repair policy.'),
  'outputs.validation.fields': field(
    'Record<string, ProfileValidator>',
    'Validators keyed by dotted paths into structured output (e.g. diagram.mermaid).',
  ),
  'outputs.validation.fields.*': field(
    '(source: unknown) => { isValid: boolean; error?: string }',
    'Host-owned validator function for this structured output field.',
  ),
  'outputs.validation.maxRetries': field('number', 'Repair-turn ceiling after a validator reject.'),
  'outputs.validation.repairGuidance': field(
    'string',
    'Instruction appended on a validation repair turn.',
  ),
  'outputs.streaming': field('ProfileStreamingSpec', 'How the turn emits live events.'),
  'outputs.streaming.mode': field(
    unionType(STREAM_MODES),
    'sse (default) or buffered.',
    STREAM_MODES,
    {
      sse: 'Server-Sent Events emitting live incremental TurnEvents.',
      buffered: 'Buffers response into a single completed turn event.',
    },
  ),
  'outputs.streaming.streamThoughts': field('boolean', 'Emit model thinking on the turn stream.'),
  turnResumption: field('ProfileTurnResumptionSpec', 'Continue after a non-user stop.'),
  'turnResumption.allowContinue': field(
    'TurnStopKind[]',
    'Kinds eligible for a Continue / continueFrom turn.',
    TURN_STOP_KINDS,
    {
      length: 'Model hit maximum output token ceiling.',
      stream_incomplete: 'Network connection or stream dropped prematurely.',
      provider_error: 'Upstream provider returned an error code or timeout.',
      tool: 'Turn paused at tool execution boundary.',
      filtered: 'Content safety filter intercepted output.',
      cancelled: 'Turn aborted via AbortSignal.',
      completed: 'Turn finished normally.',
    },
  ),
  'turnResumption.autoContinue': field(
    'TurnStopKind[]',
    'Kinds the host may auto-continue once without a CTA.',
    TURN_STOP_KINDS,
    {
      length: 'Model hit maximum output token ceiling.',
      stream_incomplete: 'Network connection or stream dropped prematurely.',
      provider_error: 'Upstream provider returned an error code or timeout.',
      tool: 'Turn paused at tool execution boundary.',
      filtered: 'Content safety filter intercepted output.',
      cancelled: 'Turn aborted via AbortSignal.',
      completed: 'Turn finished normally.',
    },
  ),
  guardrails: field(
    'ProfileGuardrailsSpec',
    'Quota, canary, sanitize, redact, and egress switches.',
  ),
  'guardrails.quota': field(
    '{ perDay: number }',
    'Host HTTP helper — not enforced inside runTurn.',
  ),
  'guardrails.quota.perDay': field('number', 'Daily turn cap used by host quota middleware.'),
  'guardrails.canary': field('boolean', 'Enable per-turn canary token bound to system prompt.'),
  'guardrails.sanitizeInput': field('boolean', 'Strip inbound injection spans.'),
  'guardrails.redactSensitive': field('boolean', 'Redact sensitive spans.'),
  'guardrails.egress': field(
    'ProfileEgressSpec',
    'Host check before user-visible text is released.',
  ),
  'guardrails.egress.enforce': field(
    'EgressEnforcer',
    'Host function: (context) => { blocked, text, … }.',
  ),
  'guardrails.egress.onBlock': field(
    unionType(EGRESS_ON_BLOCK),
    'reject_to_agent retries; refuse_to_user stops the turn.',
    EGRESS_ON_BLOCK,
    {
      reject_to_agent: 'Feeds rejection error back to model for automatic repair turn.',
      refuse_to_user: 'Halts turn immediately and returns refusal to user.',
    },
  ),
  'guardrails.egress.maxRetries': field('number', 'Repair-turn ceiling after an egress block.'),
  'guardrails.egress.repairGuidance': field(
    'string',
    'Instruction appended on an egress repair turn.',
  ),
};

/** Adjacent tool catalog fields that appear next to profile examples. */
export const EXTRA_FIELDS: Record<string, FieldMeta> = {
  type: field(
    unionType(TOOL_TYPES),
    'Discriminator: builtin (provider-native) or function (host handler).',
    TOOL_TYPES,
    {
      builtin: 'Provider-native capability; wire maps to the provider adapter.',
      function:
        'Host-owned tool with Zod input/output and a handler. Profile tools.t2Loader may promote T2 tools when output includes { loaded }.',
    },
  ),
  name: field(
    'string',
    'Wire tool id — custom: tools.allow; provider builtin: model.config.*.builtInTools. Visibility via loadTier (T0/T1/T2).',
  ),
  description: field('string', 'Model-facing description included in function declarations.'),
  input: field(
    'ZodSchema',
    'Zod input schema for function tools; converted to JSON Schema at registration.',
  ),
  output: field('ZodSchema', 'Zod output schema for function tools; validates handler results.'),
  handler: field(
    'ToolHandler',
    'Host function or async generator run on model tool calls and invokeTool resumes.',
  ),
  access: field(unionType(TOOL_ACCESS), 'Semantic access level for policy and UI.', TOOL_ACCESS, {
    'read-only': 'Reads host or remote state; no lasting mutation.',
    'read-write': 'May create or update host state.',
    destructive: 'May delete, charge, or otherwise hard-to-undo actions.',
  }),
  loadTier: field(
    unionType(TOOL_LOAD_TIERS),
    'When this tool is wired to the model (profile allow / builtInTools is still required).',
    TOOL_LOAD_TIERS,
    {
      T0: 'Wired at turn start when allowed (custom on allow / builtin on the model).',
      T1: 'Wired when profile.tools.t1Policy selects it.',
      T2: 'Deferred until profile.tools.t2Loader returns { loaded } and the kernel promotes those ids.',
    },
  ),
  permission: field(
    unionType(TOOL_PERMISSION),
    'Default permission tier for this tool before the handler runs.',
    TOOL_PERMISSION,
    {
      auto: 'Run without an extra host consent step.',
      session_consent: 'Ask once per session, then remember grant.',
      always_confirm: 'Confirm on every invocation.',
    },
  ),
  category: field('string', 'Grouping label for settings and discovery.'),
  paths: field(
    'string[]',
    "Channel/path availability. Use ['*'] for all paths; omit turn path only matches '*'.",
  ),
};

/** Look up hover metadata for a dotted path (profile first, then extra). */
export function fieldMeta(path: string): FieldMeta | undefined {
  return PROFILE_FIELDS[path] ?? EXTRA_FIELDS[path];
}
