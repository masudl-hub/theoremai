/**
 * Closed unions and the profile field catalog. No Deno APIs, so host UIs and docs can import it.
 *
 * @module
 */

/** lexicon-exempt-file: authoring field-meta / closed unions — not runtime user or model copy (P2) */
import { LEXICON_NOTES, type LexiconKey } from '../guardrails/lexicon.ts';
import { EGRESS_ON_BLOCK, type EgressOnBlock, TAINT_GATES } from '../guardrails/types.ts';
import { GOOGLE_SPEECH_VOICES } from '../presets/google/speech-voices.ts';
import { PROFILE_FIELD_PRESENCE } from './profile-presence.ts';
import { profileFieldScope } from './profile-scope.ts';

export { EGRESS_ON_BLOCK, type EgressOnBlock };

export const PROFILE_TYPES = ['text', 'image', 'speech', 'live', 'decision', 'host'] as const;
export type ProfileType = (typeof PROFILE_TYPES)[number];

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

export const PROTOCOLS = ['geminiInteractions', 'geminiLive', 'openAi'] as const;
export type Protocol = (typeof PROTOCOLS)[number];

export const PROVIDERS = ['google', 'openrouter', 'local'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Keep in lockstep with `createProvider`. */
export const PROTOCOL_PROVIDERS = {
  geminiInteractions: ['google'],
  geminiLive: ['google'],
  openAi: ['openrouter', 'local'],
} as const satisfies Record<Protocol, readonly Provider[]>;

export const PROFILE_TYPE_PROTOCOLS = {
  text: ['geminiInteractions', 'openAi'],
  image: ['geminiInteractions', 'openAi'],
  speech: ['geminiInteractions', 'openAi'],
  live: ['geminiLive'],
  decision: [],
  host: [],
} as const satisfies Record<ProfileType, readonly Protocol[]>;

export type ProfileTypeProtocol<T extends ProfileType> = (typeof PROFILE_TYPE_PROTOCOLS)[T][number];

export function protocolsForProfileType(type: ProfileType): readonly Protocol[] {
  return PROFILE_TYPE_PROTOCOLS[type];
}

export function isValidProfileProtocol(type: ProfileType, protocol: Protocol): boolean {
  return (PROFILE_TYPE_PROTOCOLS[type] as readonly string[]).includes(protocol);
}

export const KEY_SLOTS = ['slotA', 'slotB', 'slotC', 'paid'] as const;
export type KeySlot = (typeof KEY_SLOTS)[number];

/** Key slots that may overflow to `paid` after quota backoff. */
export const OVERFLOW_KEY_SLOTS = ['slotA', 'slotB', 'slotC'] as const satisfies readonly Exclude<
  KeySlot,
  'paid'
>[];
export type OverflowKeySlot = (typeof OVERFLOW_KEY_SLOTS)[number];

export type KeyVault = Record<KeySlot, string | undefined>;

export const MEDIA_INPUT_KIND_VALUES = ['image', 'audio', 'video', 'document'] as const;
export type MediaInputKind = (typeof MEDIA_INPUT_KIND_VALUES)[number];

export const SUMMARY_MODES = ['auto', 'none'] as const;
export type SummaryMode = (typeof SUMMARY_MODES)[number];

export const STREAM_MODES = ['sse', 'buffered'] as const;
export type StreamMode = (typeof STREAM_MODES)[number];

export const SPEECH_AUDIO_FORMATS = ['pcm', 'mp3'] as const;
export type SpeechAudioFormat = (typeof SPEECH_AUDIO_FORMATS)[number];

export function speechFormatsForProtocol(protocol: Protocol): readonly SpeechAudioFormat[] {
  return protocol === 'openAi' ? SPEECH_AUDIO_FORMATS : ['pcm'];
}

export function isSpeechFormatAllowedForProtocol(
  protocol: Protocol,
  format: SpeechAudioFormat,
): boolean {
  return speechFormatsForProtocol(protocol).includes(format);
}

/** Snap a format the protocol can't send to its first legal one; unset stays unset. */
export function coerceSpeechFormat(
  protocol: Protocol,
  format: SpeechAudioFormat | undefined,
): SpeechAudioFormat | undefined {
  if (format === undefined) return undefined;
  const allowed = speechFormatsForProtocol(protocol);
  return allowed.includes(format) ? format : allowed[0];
}

export const LIVE_ACTIVITY_HANDLINGS = ['START_OF_ACTIVITY_INTERRUPTS', 'NO_INTERRUPTION'] as const;
export type LiveActivityHandling = (typeof LIVE_ACTIVITY_HANDLINGS)[number];

export const LIVE_SPEECH_SENSITIVITIES = [
  'START_SENSITIVITY_LOW',
  'START_SENSITIVITY_HIGH',
  'END_SENSITIVITY_LOW',
  'END_SENSITIVITY_HIGH',
] as const;
export type LiveSpeechSensitivity = (typeof LIVE_SPEECH_SENSITIVITIES)[number];

export const COMPACTION_METERS = ['history', 'input'] as const;
export type CompactionMeter = (typeof COMPACTION_METERS)[number];

export const COMPACTION_TIMINGS = ['before', 'after'] as const;
export type CompactionTiming = (typeof COMPACTION_TIMINGS)[number];

export const CACHE_MODES = ['automatic', 'system'] as const;
export type CacheMode = (typeof CACHE_MODES)[number];

export const CACHE_TTLS = ['5m', '1h'] as const;
export type CacheTtl = (typeof CACHE_TTLS)[number];

export const TURN_STOP_KINDS = [
  'completed',
  'length',
  /** The model called tools and the turn hands them to the host (`done.tools`). */
  'tool',
  /** `pre_tool` blocked the body; the host resumes via invokeTool/executeTool, not continueFrom. */
  'gate',
  'filtered',
  'provider_error',
  'cancelled',
  'stream_incomplete',
  'interrupted',
  /** Live: model finished generating audio/text for this utterance; turn may still be open. */
  'generation_complete',
] as const;
export type TurnStopKind = (typeof TURN_STOP_KINDS)[number];

/** Every other stop resumes by another host path, or not at all. */
export const CONTINUE_STOP_KINDS = ['length', 'stream_incomplete', 'provider_error'] as const;
export type ContinueStopKind = (typeof CONTINUE_STOP_KINDS)[number];

export const TURN_STAGES = [
  'pre_turn',
  'pre_tool',
  'post_tool',
  'before_end',
  'post_turn',
] as const;
export type TurnStage = (typeof TURN_STAGES)[number];

const TURN_STAGE_SET = new Set<string>(TURN_STAGES);

export function isTurnStage(value: unknown): value is TurnStage {
  return typeof value === 'string' && TURN_STAGE_SET.has(value);
}

/** Stages where an inject can land; the inject gate still applies. */
export const TURN_INJECT_STAGES = ['pre_turn', 'post_tool', 'before_end'] as const;
export type TurnInjectStage = (typeof TURN_INJECT_STAGES)[number];

const TURN_INJECT_STAGE_SET = new Set<string>(TURN_INJECT_STAGES);

export function isTurnInjectStage(value: unknown): value is TurnInjectStage {
  return typeof value === 'string' && TURN_INJECT_STAGE_SET.has(value);
}

/** `pre_tool` gates; not `awaiting_user_input`. */
export const TOOL_GATE_KINDS = ['confirmation', 'permission', 'auth'] as const;
export type ToolGateKind = (typeof TOOL_GATE_KINDS)[number];

/** Why a refused gate settles: the user said no, or walked away. */
export const TOOL_RESUME_CAUSES = ['declined', 'abandoned'] as const;
export type ToolResumeCause = (typeof TOOL_RESUME_CAUSES)[number];

const TOOL_GATE_KIND_SET = new Set<string>(TOOL_GATE_KINDS);

export function isToolGateKind(value: unknown): value is ToolGateKind {
  return typeof value === 'string' && TOOL_GATE_KIND_SET.has(value);
}
export const AWAITING_USER_INPUT_KINDS = ['confirm', 'choice', 'text'] as const;
export type AwaitingUserInputKind = (typeof AWAITING_USER_INPUT_KINDS)[number];

export const STAGE_APPLY_WARNING_CODES = [
  'affordance_not_allowed',
  'inject_not_allowed',
  'inject_rejected_max_steps',
  'inject_invalid_messages',
  'inject_id_invalid',
  'deny_invalid',
  'confirm_invalid',
  'mutate_invalid',
  'abort_invalid',
  'unknown_field',
  'result_invalid',
] as const;
export type StageApplyWarningCode = (typeof STAGE_APPLY_WARNING_CODES)[number];

export const AWAITING_USER_INPUT_STATUS = 'awaiting_user_input' as const;
/** Enforced by the kernel at resolve time. */
export const TOOL_LOAD_TIERS = ['T0', 'T1', 'T2'] as const;
export type ToolLoadTier = (typeof TOOL_LOAD_TIERS)[number];

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** When remote tool auth is missing or expired. */
export const AUTH_UNAUTHENTICATED_POLICIES = ['gate', 'report_to_model'] as const;
export type AuthUnauthenticatedPolicy = (typeof AUTH_UNAUTHENTICATED_POLICIES)[number];

export const TOOL_TYPES = ['builtin', 'function', 'http', 'mcp'] as const;

export const TOOL_ACCESS = ['read-only', 'read-write', 'destructive'] as const;
export type ToolAccess = (typeof TOOL_ACCESS)[number];

export const TOOL_PERMISSION = ['auto', 'session_consent', 'always_confirm'] as const;
export type ToolPermission = (typeof TOOL_PERMISSION)[number];

export const TOOL_AUTH_TYPES = ['bearer', 'api_key', 'oauth2'] as const;
export type ToolAuthType = (typeof TOOL_AUTH_TYPES)[number];

/** Adds UI-only `none`, which omits auth at compile time. */
export const PLAYGROUND_AUTH_TYPES = ['none', ...TOOL_AUTH_TYPES] as const;
export type PlaygroundAuthType = (typeof PLAYGROUND_AUTH_TYPES)[number];

export type ToolType = (typeof TOOL_TYPES)[number];
export type CustomToolType = Exclude<ToolType, 'builtin'>;

/**
 * The package's complete media-input vocabulary: `assertMediaMime` refuses any MIME not
 * here, so hosts keep no second table. Rows follow Google Interactions / Live's documented
 * lists (verified 2026-09-12), the widest provider; TypeScript, `application/xml` and
 * `application/rtf` are not on Google's list. OpenAI-compat adapters forward the MIME
 * verbatim and add no rows. Provider alias essences (`image/jpg`, `video/mov`, …) are rows;
 * `resolveInputParts` canonicalizes `image/jpg` to `image/jpeg` on the wire.
 */
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
  'audio/m4a': 'audio',
  'audio/opus': 'audio',
  'audio/l16': 'audio',
  'audio/alaw': 'audio',
  'audio/mulaw': 'audio',
  'video/mp4': 'video',
  'video/mpeg': 'video',
  'video/quicktime': 'video',
  'video/mov': 'video',
  'video/x-msvideo': 'video',
  'video/avi': 'video',
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
  'text/md': 'document',
  'text/html': 'document',
  'text/css': 'document',
  'text/xml': 'document',
  'text/rtf': 'document',
  'text/javascript': 'document',
  'application/x-javascript': 'document',
  'text/x-python': 'document',
  'application/x-python': 'document',
  'application/json': 'document',
};

/** Type-prefix wildcards accepted by `mimeAllowed`. */
export const MEDIA_WILDCARDS = ['image/*', 'audio/*', 'video/*'] as const;

function mimesOf(kind: MediaInputKind): string[] {
  return Object.keys(MEDIA_INPUT_KINDS).filter((mime) => MEDIA_INPUT_KINDS[mime] === kind);
}

export const ATTACHMENT_ACCEPT_MIMES: readonly string[] = [
  'image/*',
  'video/*',
  ...mimesOf('image'),
  ...mimesOf('video'),
  ...mimesOf('document'),
];

/**
 * The attachment `accept` values an image profile may list: images, video and
 * PDF, the inputs image models document reading. Also the allowlist each of its
 * `accept` entries must fall within.
 */
export const IMAGE_ATTACHMENT_ACCEPT_MIMES: readonly string[] = [
  'image/*',
  'video/*',
  ...mimesOf('image'),
  ...mimesOf('video'),
  'application/pdf',
];

export const VOICE_ACCEPT_MIMES: readonly string[] = ['audio/*', ...mimesOf('audio')];

export function providersFor(protocol: Protocol): readonly Provider[] {
  return PROTOCOL_PROVIDERS[protocol];
}

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

export type FieldMeta = {
  type: string;
  doc: string;
  options?: readonly string[];
  optionDescriptions?: Record<string, string>;
  optionNote?: string;
  /** Types the field may be set on, when not every type; `defineProfile` rejects it elsewhere. */
  profileTypes?: readonly ProfileType[];
  /** Why the other types can't take it. */
  profileTypesReason?: string;
  /** The profile must set the field: always (`true`), or only in the case named. */
  required?: true | string;
  /** What leaving the field out does, as a short phrase a blank control can show. */
  unset?: string;
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
  'lexicon',
  'inputs.slots',
  'inputs.limitsByMime',
  'outputs.validation.fields',
]);

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

function withScopeAndPresence(fields: Record<string, FieldMeta>): Record<string, FieldMeta> {
  return Object.fromEntries(
    Object.entries(fields).map(([path, meta]) => {
      const scope = profileFieldScope(path);
      return [
        path,
        {
          ...meta,
          ...(scope ? { profileTypes: scope.profileTypes, profileTypesReason: scope.reason } : {}),
          ...PROFILE_FIELD_PRESENCE[path],
        },
      ];
    }),
  );
}

/**
 * Adding a profile field? Add it here; scope it in `PROFILE_FIELD_SCOPE` if only some types
 * take it, and record it in `PROFILE_FIELD_PRESENCE` if it is required or its absence matters.
 */
export const PROFILE_FIELDS: Record<string, FieldMeta> = withScopeAndPresence({
  id: field('string', 'Host-owned profile identifier.'),
  type: field(
    "'text' | 'image' | 'speech' | 'live' | 'decision' | 'host'",
    'Required profile archetype. host = tool-execution ceiling for invokeTool; never runs a model.',
    PROFILE_TYPES,
  ),
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
  decision: field(
    '{ contract: DecisionContractId }',
    'Which host decision this Jev profile makes. Jev never sees it; it answers the questions each call asks.',
  ),
  'decision.contract': field(
    'string',
    'Host-owned id for the decision, recorded on each decide span as theorem.decision.contract. Not sent to Jev and not checked against the questions.',
  ),
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
  'models.*.cache': field(
    'CacheSpec',
    'OpenRouter prompt-cache policy. Only valid when provider is openrouter.',
  ),
  'models.*.cache.mode': field(
    unionType(CACHE_MODES),
    'How to place cache_control on OpenRouter requests.',
    CACHE_MODES,
    {
      automatic: 'Top-level cache_control; breakpoint advances with the conversation.',
      system: 'Explicit cache_control breakpoint on the system instruction only.',
    },
  ),
  'models.*.cache.ttl': field(
    unionType(CACHE_TTLS),
    'Ephemeral cache TTL. Omit → provider default (typically 5m on Anthropic).',
    CACHE_TTLS,
    {
      '5m': 'Five-minute ephemeral cache (default when ttl is omitted).',
      '1h': 'One-hour ephemeral cache (higher write cost; better for long sessions).',
    },
  ),
  'models.*.store': field(
    'boolean',
    'Gemini Interactions: whether the provider stores the interaction. Omit → provider default.',
  ),
  'models.*.persistViaInteractionId': field(
    'boolean',
    'Gemini Interactions: prefer previous_interaction_id over client-owned history. Omit → host/turn decides.',
  ),
  'models.*.server': field(
    'string',
    'Local server hosting the model (ollama, vllm, …). Traces report it as gen_ai.provider.name. Only valid when provider is local.',
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
    'Custom tools (allow), optional T1 policy, optional T2 loader function id. Builtins belong on models.*.builtInTools.',
  ),
  'tools.allow': field(
    'ToolId[]',
    'Custom tools the agent may call. Builtins are declared per model, not here. On type live every listed id is wired at session setup regardless of loadTier; on type host every listed id is executable.',
  ),
  'tools.t1Policy': field(
    '(ctx) => ToolId[] | Promise<ToolId[]>',
    'Optional T1 policy — which eligible loadTier:T1 tools to wire at turn start.',
  ),
  'tools.t2Loader': field(
    'ToolId',
    'Optional function tool id for T2 promotion. Must be in tools.allow; handler returns { loaded: string[] }.',
  ),
  inputs: field(
    'ProfileInputsSpec | DecisionInputsSpec',
    'Text, attachment, voice, slot, and size rules; on a decision, the JSON state it reads.',
  ),
  'inputs.state': field(
    "'json'",
    'What a decision reads: non-null JSON state, passed on each runDecision call.',
    ['json'],
  ),
  'inputs.maxStateBytes': field(
    'number',
    'Max UTF-8 bytes of the serialized state per call. A larger state is rejected before it leaves the process.',
  ),
  'inputs.text': field(
    'boolean',
    'Whether the profile accepts text on a turn. False rejects text.',
  ),
  'inputs.attachments': field('{ accept: string[] }', 'File upload allowlist.'),
  'inputs.attachments.accept': field(
    'string[]',
    'MIME allowlist for uploaded files. Type-prefix wildcards (image/*, …) are allowed. ' +
      'An image profile takes images, video and PDF only (IMAGE_ATTACHMENT_ACCEPT_MIMES).',
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
    'Optional turn-time selectors (e.g. language: ["html", "tsx"]). A turn may pass only these slots.',
  ),
  'inputs.slots.*': field(
    'string[]',
    'Allowed choices for this turn selector. A turn passing any other value is rejected.',
  ),
  outputs: field('ProfileOutputsSpec', 'Structured, validation, and streaming output policy.'),
  'outputs.structured': field(
    'StructuredSchemaId | StructuredBySlot | null',
    'Registered schema id, slot-mapped ids, or null for free text.',
  ),
  image: field('ProfileImageSpec', 'Pins for an image-role profile. Model id is on model.'),
  'image.aspectRatio': field('string', 'Optional output aspect ratio. Omitted → provider default.'),
  'image.size': field('string', 'Optional output size / resolution. Omitted → provider default.'),
  'image.mimeType': field('string', 'Output MIME for generated images.'),
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
    'Audio format asked of the provider; unset sends none, so the provider picks. pcm arrives as WAV. mp3 requires protocol openAi.',
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
    'LiveContextCompressionSpec',
    'Context window compression: shrinks the context once it reaches the trigger.',
  ),
  'live.contextCompression.triggerTokens': field(
    'number',
    'Context tokens, counted before a turn, that start compression.',
  ),
  'live.contextCompression.slidingWindow': field(
    'LiveSlidingWindowSpec',
    'Drops the oldest turns down to the target; the system instruction stays.',
  ),
  'live.contextCompression.slidingWindow.targetTokens': field(
    'number',
    'Tokens kept after compressing; below the trigger.',
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
    '(candidate: unknown, slots?: Record<string, string>) => ValidationResult | Promise<ValidationResult>',
    'Host-owned validator for this structured output field; returns { isValid, error?, finding?, data? }.',
  ),
  'outputs.validation.maxRetries': field('number', 'Repair-turn ceiling after a validator reject.'),
  'outputs.streaming': field('ProfileStreamingSpec', 'How the turn emits live events.'),
  'outputs.streaming.mode': field(
    unionType(STREAM_MODES),
    'Whether the provider call streams. Either way the host gets the same TurnEvents.',
    STREAM_MODES,
    {
      sse: 'Stream the provider call; TurnEvents arrive as the model produces them.',
      buffered: 'One non-streaming provider call; its TurnEvents arrive together when it answers.',
    },
  ),
  'outputs.streaming.streamThoughts': field('boolean', 'Emit model thinking on the turn stream.'),
  turnBehaviour: field(
    'ProfileTurnBehaviourSpec',
    'Resume after a non-user stop (text/image/speech); text and live may also allow mid-turn inject via allowSteering.',
  ),
  'turnBehaviour.resumption': field(
    'ProfileTurnResumptionSpec',
    'Continue after a non-user stop (continueFrom). Not valid on live — use live.sessionResumption.',
  ),
  'turnBehaviour.resumption.allowContinue': field(
    'ContinueStopKind[]',
    'Stops after which the host offers the user a Continue (then sends continueFrom); isResumeableStop reads it. Host UI policy — the kernel does not refuse a continueFrom outside it. Omitted → all three; [] → none. Tool, cancelled, completed and filtered stops never are.',
    CONTINUE_STOP_KINDS,
    {
      length: 'Model hit maximum output token ceiling.',
      stream_incomplete: 'Network connection or stream dropped prematurely.',
      provider_error: 'Upstream provider returned an error code or timeout.',
    },
  ),
  'turnBehaviour.resumption.autoContinue': field(
    'ContinueStopKind[]',
    'Stops the host continues once on its own, without asking. Omitted → length and stream_incomplete; [] → none.',
    CONTINUE_STOP_KINDS,
    {
      length: 'Model hit maximum output token ceiling.',
      stream_incomplete: 'Network connection or stream dropped prematurely.',
      provider_error: 'Upstream provider returned an error code or timeout.',
    },
  ),
  'turnBehaviour.resumption.maxContinues': field(
    'number',
    'How many times one reply may be continued. Omitted → no cap. Once set, each continue must carry its count (TurnRequest.continuation).',
  ),
  'turnBehaviour.allowSteering': field(
    'boolean',
    'Text and live. When true (default), host onStage inject affordances are applied. Image/speech must omit.',
  ),
  guardrails: field(
    'ProfileGuardrailsSpec',
    'Quota, canary, sanitize, redact, egress, network, taint, and (decision) disclosure switches.',
  ),
  'guardrails.quota': field(
    'QuotaGuardrailSpec',
    'Host HTTP helper — not enforced inside runTurn.',
  ),
  'guardrails.quota.perDay': field('number', 'Daily turn cap used by host quota middleware.'),
  'guardrails.canary': field(
    'boolean',
    "Per-turn canary token bound to system prompt. Default true; set false to opt out. The bind note is lexicon 'canary.bind_note'.",
  ),
  'guardrails.sanitizeInput': field('boolean', 'Strip inbound injection spans.'),
  'guardrails.redactSensitive': field('boolean', 'Redact sensitive spans.'),
  'guardrails.egress': field(
    'ProfileEgressSpec',
    'Host check before user-visible text is released.',
  ),
  'guardrails.egress.enforce': field(
    'EgressEnforcer',
    'Your check on the reply, run as it streams and when it ends. Return allow, flag (log only), redact (swap in your text) or block (see onBlock); a block or redact holds the rest of the stream, and a throw counts as a block. Bundled: standardEgressEnforce.',
  ),
  'guardrails.egress.onBlock': field(
    unionType(EGRESS_ON_BLOCK),
    'What happens when enforce blocks the reply. Unset → reject_to_agent.',
    EGRESS_ON_BLOCK,
    {
      reject_to_agent:
        "The model reads the block's rejection and writes the reply again, up to maxRetries times (or outputs.validation.maxRetries, if larger). With no retries left (the default is 0), the reply is withheld and the turn ends with a safety error.",
      refuse_to_user:
        "The user reads the lexicon's egress.refusal line in place of the reply, and the turn ends.",
    },
  ),
  'guardrails.egress.maxRetries': field('number', 'Repair-turn ceiling after an egress block.'),
  'guardrails.egress.holdback': field(
    'number',
    'Characters held back mid-stream so enforce sees split matches (default 256).',
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
  'guardrails.taint': field(
    'TaintGuardrailSpec',
    'What the turn may still do after reading untrusted remote content.',
  ),
  'guardrails.taint.afterRemoteRead': field(
    unionType(TAINT_GATES),
    'Least-severe tool capability refused once the turn has read remote content. Default off.',
    TAINT_GATES,
    {
      off: 'Report only.',
      destructive: 'Refuse hard-to-undo calls.',
      write: 'Refuse hard-to-undo calls and any state-changing call.',
    },
  ),
  'guardrails.disclosure': field(
    '{ enforce: DecisionDisclosureEnforcer }',
    'Pre-dispatch policy for structured state leaving a decision profile.',
  ),
  'guardrails.disclosure.enforce': field(
    '(state, context) => DecisionDisclosureVerdict | Promise<DecisionDisclosureVerdict>',
    'Allows or blocks the state before it is sent to the decision model.',
  ),
  lexicon: field(
    'LexiconOverrides',
    "This profile's wording, by lexicon key: user-facing error lines (error.<kind>), notices, and model-facing notes. Wins over overrideLexicon and the defaults.",
  ),
  'lexicon.*': field(
    'string',
    'The wording for one lexicon key. Keys with placeholders must keep them (canary.bind_note keeps {canary}).',
  ),
  observability: field(
    'ProfileObservabilitySpec',
    'Trace destination, scrub, include, and sampling policy for this profile.',
  ),
  'observability.writeTo': field(
    'false | string | TraceSink',
    'false = off; string = registerTraceDestination id; TraceSink = inline writer. runTurn third arg overrides.',
  ),
  'observability.sampleRate': field(
    'number',
    'Fraction of traces to record (0–1), decided by trace id so a trace is kept or dropped whole. Default 1. Ignored when runTurn passes an explicit sink.',
  ),
  'observability.include': field(
    'TraceIncludeSpec',
    'Which TraceRecord payloads to keep (upstreamLog, outboundWire, evidenceRaw, usage, guardrailDecisions, guardrailMatchPreview).',
  ),
  'observability.include.upstreamLog': field(
    'boolean',
    'theorem.upstream.row events: each scrubbed provider row at its arrival time. Default true.',
  ),
  'observability.include.outboundWire': field(
    'boolean',
    'theorem.wire.request events: the scrubbed request body of each HTTP try. Default false.',
  ),
  'observability.include.evidenceRaw': field(
    'boolean',
    'The provider raw payload on theorem.grounding events. Default false.',
  ),
  'observability.include.usage': field('boolean', 'Token / usage fields. Default true.'),
  'observability.include.guardrailDecisions': field(
    'boolean',
    'Persist { type: "guardrail" } decisions in the TraceRecord. Default true.',
  ),
  'observability.include.guardrailMatchPreview': field(
    'boolean',
    'Keep GuardrailHit.match (the exact matched text) on stream + TraceRecord. Default false — debugging only.',
  ),
  'observability.resource': field(
    'Record<string, TraceAttributeValue>',
    'Process attributes stamped on every TraceRecord (e.g. service.name). Default {}.',
  ),
  'observability.scrub': field(
    'TraceScrubSpec',
    'Scrubbing of stored records — independent of profile.guardrails. Defaults on.',
  ),
  'observability.scrub.sensitive': field(
    'boolean',
    'Strip credentials / PII spans in stored text. Default true.',
  ),
  'observability.scrub.injection': field(
    'boolean',
    'Strip injection spans in the stored request copy. Default true.',
  ),
  'observability.scrub.canary': field('boolean', 'Never persist the canary token. Default true.'),
  'observability.retainForDays': field(
    'number',
    'Days to keep each record, handed to every destination with the record; <=0 keeps records forever. Default 14.',
  ),
  'observability.rotateAfterMiB': field(
    'number',
    'JSONL rotate threshold in MiB when writeTo resolves to a jsonl destination. Default 32.',
  ),
  'observability.onWriteError': field(
    '(err: unknown) => void',
    'Host hook when record build or destination write fails. Must not throw.',
  ),
});

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
    'HTTP URL template for declarative tools. Use {param} placeholders for path segments; the scheme and host are fixed text.',
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
      ['api_' + 'key']: 'Named header carries the resolved credential value.',
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
    'Whether a missing/expired credential gates the turn or reports to the model.',
    AUTH_UNAUTHENTICATED_POLICIES,
    {
      gate: 'Stop the turn at an auth gate and wait for the host to supply a credential.',
      report_to_model: 'Return a model-visible finding without gating the turn.',
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
      ['api_' + 'key']: 'Named header carries the resolved credential value.',
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
  'playground.sampleInput': field(
    'Record<string, unknown>',
    "Playground-only: tool input for the connection test, filling the endpoint's path, query and body. Not saved.",
  ),
  'playground.inputSchema': field(
    'Record<string, unknown>',
    'Playground-only: the tool input as a JSON Schema object, sent to the model as its parameters.',
  ),
  'playground.outputSchema': field(
    'Record<string, unknown>',
    'Playground-only: the tool result as a JSON Schema object. A function tool with no stub output returns a stand-in built from it.',
  ),
  'registerStructured.jsonSchema': field(
    'Record<string, unknown>',
    'JSON Schema body registered under outputs.structured id; sent to the model as its response format.',
  ),
  access: field(unionType(TOOL_ACCESS), 'Semantic access level for policy and UI.', TOOL_ACCESS, {
    'read-only': 'Reads host or remote state; no lasting mutation.',
    'read-write': 'May create or update host state.',
    destructive: 'May delete, charge, or otherwise hard-to-undo actions.',
  }),
  loadTier: field(
    unionType(TOOL_LOAD_TIERS),
    'When this tool is wired to the model (profile allow / builtInTools is still required). Live sessions wire every allowed tool at setup; host profiles execute every allowed tool.',
    TOOL_LOAD_TIERS,
    {
      T0: 'Wired at turn/session start when allowed (custom on allow / builtin on the model).',
      T1: 'Wired when profile.tools.t1Policy selects it (text/image turns; live wires it at setup).',
      T2: 'Deferred until profile.tools.t2Loader returns { loaded } and the kernel promotes those ids (text/image turns; live wires it at setup).',
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

/** `lexicon.<key>` resolves to `lexicon.*` with that key's own note. */
export function fieldMeta(path: string): FieldMeta | undefined {
  const meta = PROFILE_FIELDS[path] ?? EXTRA_FIELDS[path];
  if (meta || !path.startsWith('lexicon.')) return meta;
  const key = path.slice('lexicon.'.length);
  const wildcard = PROFILE_FIELDS['lexicon.*'];
  if (!wildcard || !Object.hasOwn(LEXICON_NOTES, key)) return undefined;
  return { ...wildcard, doc: LEXICON_NOTES[key as LexiconKey] };
}

export type {
  ProfileGraphEditor,
  ProfileGraphFacet,
  ProfileGraphFacetId,
  ProfileGraphRole,
} from './profile-graph.ts';
export { PROFILE_GRAPH, profileGraphFacet, spineFacetsForProfileType } from './profile-graph.ts';
