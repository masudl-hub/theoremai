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

/** Primary profile archetype. Discriminated union key for `ProfileDefinition` and `Profile`. */
export const PROFILE_TYPES = ['text', 'image', 'speech', 'live'] as const;
export type ProfileType = (typeof PROFILE_TYPES)[number];

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

/**
 * Legal wire protocols for each profile archetype.
 * 'live' profiles require 'geminiLive'; turn-based archetypes require turn protocols.
 */
export const PROFILE_TYPE_PROTOCOLS = {
  text: ['geminiInteractions', 'openAi'],
  image: ['geminiInteractions', 'openAi'],
  speech: ['geminiInteractions', 'openAi'],
  live: ['geminiLive'],
} as const satisfies Record<ProfileType, readonly Protocol[]>;

export type ProfileTypeProtocol<T extends ProfileType> = (typeof PROFILE_TYPE_PROTOCOLS)[T][number];

/** Protocols allowed for a profile archetype (`type`). */
export function protocolsForProfileType(type: ProfileType): readonly Protocol[] {
  return PROFILE_TYPE_PROTOCOLS[type];
}

/** True when the protocol is valid for the given profile archetype. */
export function isValidProfileProtocol(type: ProfileType, protocol: Protocol): boolean {
  return (PROFILE_TYPE_PROTOCOLS[type] as readonly string[]).includes(protocol);
}

/** Named vault key slots for host-supplied credentials (provider-neutral). */
export const KEY_SLOTS = ['slotA', 'slotB', 'slotC', 'paid'] as const;
export type KeySlot = (typeof KEY_SLOTS)[number];

/** Key slots that may overflow to `paid` after quota backoff. */
export const OVERFLOW_KEY_SLOTS = ['slotA', 'slotB', 'slotC'] as const satisfies readonly Exclude<
  KeySlot,
  'paid'
>[];
export type OverflowKeySlot = (typeof OVERFLOW_KEY_SLOTS)[number];

/** Host vault: one optional credential string per key slot. */
export type KeyVault = Record<KeySlot, string | undefined>;

/** Profile-level control a caller may toggle at turn time. */
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

/** Speech `format` values legal for a wire protocol (`assertSpeechRole` / UI). */
export function speechFormatsForProtocol(protocol: Protocol): readonly SpeechAudioFormat[] {
  return protocol === 'openAi' ? SPEECH_AUDIO_FORMATS : ['pcm'];
}

export function isSpeechFormatAllowedForProtocol(
  protocol: Protocol,
  format: SpeechAudioFormat,
): boolean {
  return speechFormatsForProtocol(protocol).includes(format);
}

/** Snap an illegal or omitted format to the first legal value for the protocol. */
export function coerceSpeechFormat(
  protocol: Protocol,
  format: SpeechAudioFormat | undefined,
): SpeechAudioFormat {
  const allowed = speechFormatsForProtocol(protocol);
  if (format && allowed.includes(format)) return format;
  return allowed[0];
}

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
  /** Live: model finished generating audio/text for this utterance; turn may still be open. */
  'generation_complete',
] as const;
export type TurnStopKind = (typeof TURN_STOP_KINDS)[number];

/** Per-tool visibility tier — enforced by the kernel at resolve time. */
export const TOOL_LOAD_TIERS = ['T0', 'T1', 'T2'] as const;
export type ToolLoadTier = (typeof TOOL_LOAD_TIERS)[number];

/**
 * Load tiers valid on `type: 'live'` profiles.
 * Gemini Live (and similar) fix function declarations at session setup — T1/T2 cannot be added mid-session.
 */
export const LIVE_TOOL_LOAD_TIERS = ['T0'] as const satisfies readonly ToolLoadTier[];
export type LiveToolLoadTier = (typeof LIVE_TOOL_LOAD_TIERS)[number];

/** HTTP verbs supported by declarative HTTP tools. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** When remote tool auth is missing or expired. */
export const AUTH_UNAUTHENTICATED_POLICIES = ['pause', 'report_to_model'] as const;
export type AuthUnauthenticatedPolicy = (typeof AUTH_UNAUTHENTICATED_POLICIES)[number];

/** Registered tool discriminant (`registerTool`). */
export const TOOL_TYPES = ['builtin', 'function', 'http', 'mcp'] as const;

/** Semantic access level — host policy / UI; not enforced by execute. */
export const TOOL_ACCESS = ['read-only', 'read-write', 'destructive'] as const;
export type ToolAccess = (typeof TOOL_ACCESS)[number];

/** Execution authorization tier for registered tools. */
export const TOOL_PERMISSION = ['auto', 'session_consent', 'always_confirm'] as const;
export type ToolPermission = (typeof TOOL_PERMISSION)[number];

/** Credential attachment modes for HTTP and MCP tools (`auth.type`). */
export const TOOL_AUTH_TYPES = ['bearer', 'api_key', 'oauth2'] as const;
export type ToolAuthType = (typeof TOOL_AUTH_TYPES)[number];

/** Playground auth select — includes UI-only `none` (omits auth at compile time). */
export const PLAYGROUND_AUTH_TYPES = ['none', ...TOOL_AUTH_TYPES] as const;
export type PlaygroundAuthType = (typeof PLAYGROUND_AUTH_TYPES)[number];

export type ToolType = (typeof TOOL_TYPES)[number];
/** Custom registerTool discriminants (excludes provider builtins). */
export type CustomToolType = Exclude<ToolType, 'builtin'>;

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
 * The annotator substitutes `*` so `models.flash.apiId` → `models.*.apiId`.
 */
export const DYNAMIC_FIELD_PARENTS: ReadonlySet<string> = new Set([
  'models',
  'models.*.efforts',
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
  models: field(
    'Record<ModelId, ModelBinding>',
    'Host-named model bindings. Keys are model ids; each entry carries protocol, provider, and wire config.',
  ),
  'models.*': field('ModelBinding', 'Wire binding for one host-named model id.'),
  'models.*.protocol': field(
    unionType(PROTOCOLS),
    'Wire protocol for this model. Must be valid for profile type.',
    PROTOCOLS,
    {
      geminiInteractions: 'Google Gemini Interactions wire protocol (Gemini 2.5 / 3+).',
      geminiLive: 'Gemini Live bidirectional WebSocket protocol.',
      openAi: 'OpenAI-compatible chat completions and streaming protocol.',
    },
  ),
  'models.*.provider': field(
    unionType(PROVIDERS),
    'Transport for this model. Must form a legal pair with protocol.',
    PROVIDERS,
    {
      google: 'Direct Google Gemini API transport.',
      openrouter: 'OpenRouter multi-provider API proxy.',
      local: 'Local OpenAI-compatible server (Ollama, llama.cpp, vLLM).',
    },
  ),
  'models.*.apiId': field('string', 'Provider wire model id.'),
  'models.*.efforts': field(
    'Record<string, ThinkingLevel>',
    'Alias → thinking level. One entry = fixed; two+ may be selectable at turn time.',
  ),
  'models.*.efforts.*': field(
    unionType(THINKING_LEVELS),
    'Wire thinking level for this effort alias.',
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
  'models.*.defaultEffort': field('string', 'Effort alias when the turn omits effort.'),
  'models.*.allowEffortSelect': field(
    'boolean',
    'Turn may pass effort. Requires two or more efforts keys.',
  ),
  'models.*.summaries': field('boolean', 'Emit thinking summaries on the stream.'),
  'models.*.maxOutputTokens': field('number', 'Maximum tokens the model may emit.'),
  'models.*.temperature': field('number', 'Sampling temperature.'),
  'models.*.builtInTools': field(
    'BuiltinToolId[]',
    'Provider-native builtins enabled whenever this model is selected.',
  ),
  'models.*.key': field(
    unionType(KEY_SLOTS),
    'Optional vault slot for this model. Overrides profile.key.',
    KEY_SLOTS,
  ),
  'models.*.compaction': field('CompactionSpec', 'Optional compaction policy for this model.'),
  'models.*.compaction.maxTokens': field(
    'number',
    'Token budget compared by the trigger (compactAt * maxTokens).',
  ),
  'models.*.compaction.compactAt': field(
    'number',
    'Fraction of maxTokens at which compaction fires. Must be in (0, 1).',
  ),
  'models.*.compaction.previousExchanges': field(
    'number',
    '≥ 1 = exchange count, (0, 1) = fraction of maxTokens, 0 = compact all.',
  ),
  'models.*.compaction.profile': field(
    'ProfileId',
    'Compaction agent profile id. Must be registered before the owning profile.',
  ),
  'models.*.compaction.timing': field(
    unionType(COMPACTION_TIMINGS),
    'When compaction runs relative to the primary turn.',
    COMPACTION_TIMINGS,
    {
      before: 'Compact synchronously before running the turn request.',
      after: 'Signal on done for host async background compaction.',
    },
  ),
  'models.*.compaction.meter': field(
    unionType(COMPACTION_METERS),
    'What the threshold meters. Defaults to history.',
    COMPACTION_METERS,
    {
      history: 'Meters token count across prior conversation turns.',
      input: 'Meters full turn input token count (system + history + attachments).',
    },
  ),
  defaultModel: field('ModelId', 'Default model id when the turn omits model.'),
  allowModelSelect: field('boolean', 'Turn may pass model. Requires two or more models keys.'),
  maxSteps: field(
    'number',
    'Tool-loop ceiling. <=0 unbounded, 1 one-shot, >1 ceiling. Omit → unbounded.',
  ),
  key: field(
    unionType(OVERFLOW_KEY_SLOTS),
    'Vault key slot (slotA/B/C). Paid is overflow-only via models.*.key or forcePaidKey builtins.',
    OVERFLOW_KEY_SLOTS,
  ),
  tools: field(
    '{ allow: ToolId[]; t1Policy?; t2Loader? }',
    'Custom tools (allow), optional T1 policy, optional T2 loader function id. Builtins belong on models.*.builtInTools. Live profiles use LiveProfileToolsSpec `{ allow }` only — T0 tools fixed at session setup.',
  ),
  'tools.allow': field(
    'ToolId[]',
    'Custom tools the agent may call. Builtins are declared per model, not here. On type live, every listed id must be loadTier T0.',
  ),
  'tools.t1Policy': field(
    '(ctx) => ToolId[] | Promise<ToolId[]>',
    'Optional T1 policy — which eligible loadTier:T1 tools to wire at turn start. Not supported on type live.',
  ),
  'tools.t2Loader': field(
    'ToolId',
    'Optional function tool id for T2 promotion. Must be in tools.allow; handler returns { loaded: string[] }. Not supported on type live.',
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
  'live.ingress': field(
    'LiveIngressSpec',
    'Realtime ingress toggles for sendAudio / sendVideo / sendText — not turn file attachments.',
  ),
  'live.ingress.audio': field(
    'boolean',
    'Microphone PCM via LiveSession.sendAudio. Omit → enabled.',
  ),
  'live.ingress.video': field(
    'boolean',
    'Webcam JPEG frames via LiveSession.sendVideo. Omit → enabled.',
  ),
  'live.ingress.text': field('boolean', 'Typed text via LiveSession.sendText. Omit → disabled.'),
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
    'sse or buffered. Omit → THEORUM SSE default (ResolvedGeneration.stream = true).',
    STREAM_MODES,
    {
      sse: 'Server-Sent Events emitting live incremental TurnEvents (THEORUM default when mode omitted).',
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
      interrupted: 'Live barge-in interrupted the in-flight response.',
      generation_complete: 'Live model finished generating this utterance; turn may still be open.',
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
      interrupted: 'Live barge-in interrupted the in-flight response.',
      generation_complete: 'Live model finished generating this utterance; turn may still be open.',
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
  'guardrails.network': field(
    'NetworkGuardrailSpec',
    'SSRF guardrails for declarative HTTP and MCP tools.',
  ),
  'guardrails.network.allowPrivateNetworks': field(
    'boolean',
    'Allow loopback and private-network targets when resolving tool URLs.',
  ),
  'guardrails.network.allowedHosts': field(
    'string[]',
    'Explicit hostname allowlist for declarative HTTP and MCP egress.',
  ),
};

const TOOL_TYPE_FIELD = field(
  unionType(TOOL_TYPES),
  'Discriminator: builtin (provider-native), function (host handler), http (declarative HTTP), or mcp (remote MCP).',
  TOOL_TYPES,
  {
    builtin: 'Provider-native capability; wire maps to the provider adapter.',
    function:
      'Host-owned tool with Zod input/output and a handler. Profile tools.t2Loader may promote T2 tools when output includes { loaded }.',
    http: 'Declarative HTTP tool calling remote REST/JSON endpoint with optional auth/PKCE.',
    mcp: 'Remote Model Context Protocol tool calling remote MCP server with JSON-RPC.',
  },
);

/** Adjacent tool catalog fields that appear next to profile examples. */
export const EXTRA_FIELDS: Record<string, FieldMeta> = {
  /** Playground / UI path — avoids collision with profile `type` in fieldMeta(). */
  'registerTool.type': TOOL_TYPE_FIELD,
  name: field(
    'string',
    'Wire tool id — custom: tools.allow; provider builtin: models.*.builtInTools. Visibility via loadTier (T0/T1/T2).',
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
  endpoint: field(
    'string',
    'HTTP URL template for declarative tools. Use {param} placeholders for path segments.',
  ),
  method: field(unionType(HTTP_METHODS), 'HTTP verb for declarative tools.', HTTP_METHODS),
  headers: field(
    'Record<string, string>',
    'Optional static headers merged on every HTTP or MCP request.',
  ),
  mapping: field(
    '{ pathParams?, queryParams?, bodyParam? }',
    'Maps tool input fields to URL path segments, query string, or JSON body.',
  ),
  'mapping.pathParams': field(
    'string[]',
    'Input keys substituted into {name} path segments on the endpoint template.',
  ),
  'mapping.queryParams': field('string[]', 'Input keys appended as query-string parameters.'),
  'mapping.bodyParam': field(
    'string',
    'Single input key sent as the JSON request body (POST/PUT/PATCH).',
  ),
  serverUrl: field('string', 'Streamable HTTP MCP server endpoint (JSON-RPC tools/call).'),
  mcpToolName: field('string', 'Remote tool name on the MCP server (tools/list → tools/call).'),
  auth: field(
    'HttpToolAuthConfig',
    'Optional credential slot and header wiring for HTTP and MCP tools.',
  ),
  'auth.type': field(
    unionType(TOOL_AUTH_TYPES),
    'How credentials from the slot are attached to outbound requests.',
    TOOL_AUTH_TYPES,
    {
      bearer: 'Authorization header with optional prefix (default Bearer).',
      api_key: 'Named header carries the raw key or token.',
      oauth2: 'OAuth2 access token with optional refresh via the credential slot.',
    },
  ),
  'auth.slot': field(
    'string',
    'Credential slot id resolved from ToolContext.credentials at execution time.',
  ),
  'auth.headerName': field(
    'string',
    "Request header for bearer/api_key auth (default 'Authorization').",
  ),
  'auth.headerPrefix': field(
    'string',
    "Prefix before the secret (default 'Bearer ' for bearer auth).",
  ),
  'auth.onUnauthenticated': field(
    unionType(AUTH_UNAUTHENTICATED_POLICIES),
    'Whether a missing/expired credential pauses the turn or reports to the model.',
    AUTH_UNAUTHENTICATED_POLICIES,
    {
      pause: 'Emit ToolPause { kind: auth } and wait for host credential injection.',
      report_to_model: 'Return a model-visible finding without pausing the turn.',
    },
  ),
  'auth.scopes': field('string[]', 'OAuth2 scopes requested during authorization.'),
  'auth.clientId': field('string', 'OAuth2 client id for the authorization code flow.'),
  'auth.redirectUri': field('string', 'OAuth2 redirect URI registered for this client.'),
  'playground.authType': field(
    unionType(PLAYGROUND_AUTH_TYPES),
    'Playground auth select — `none` omits auth when compiling registerTool.',
    PLAYGROUND_AUTH_TYPES,
    {
      none: 'No credential slot — tool runs without Authorization headers.',
      bearer: 'Authorization header with optional prefix (default Bearer).',
      api_key: 'Named header carries the raw key or token.',
      oauth2: 'OAuth2 access token with optional refresh via the credential slot.',
    },
  ),
  'playground.testCredential': field(
    'string',
    'Playground-only: one-shot credential for the pre-run connectivity check (not compiled into registerTool).',
  ),
  'playground.stubOutput': field(
    'Record<string, unknown>',
    'Playground-only: fixed JSON object returned by function tool stubs when no demo handler exists.',
  ),
  'registerStructured.enforced': field(
    unionType(SCHEMA_ENFORCEMENTS),
    'How structured output is enforced on the wire.',
    SCHEMA_ENFORCEMENTS,
  ),
  'registerStructured.jsonSchema': field(
    'Record<string, unknown>',
    'JSON Schema body registered under outputs.structured id.',
  ),
  access: field(unionType(TOOL_ACCESS), 'Semantic access level for policy and UI.', TOOL_ACCESS, {
    'read-only': 'Reads host or remote state; no lasting mutation.',
    'read-write': 'May create or update host state.',
    destructive: 'May delete, charge, or otherwise hard-to-undo actions.',
  }),
  loadTier: field(
    unionType(TOOL_LOAD_TIERS),
    'When this tool is wired to the model (profile allow / builtInTools is still required). Live sessions accept T0 only.',
    TOOL_LOAD_TIERS,
    {
      T0: 'Wired at turn/session start when allowed (custom on allow / builtin on the model). Required for type live.',
      T1: 'Wired when profile.tools.t1Policy selects it (text/image turns only — not live).',
      T2: 'Deferred until profile.tools.t2Loader returns { loaded } and the kernel promotes those ids (text/image turns only — not live).',
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
