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

/** The kinds of profile: each fixes which fields and models a profile may use. */
export const PROFILE_TYPES = ['text', 'image', 'speech', 'live', 'decision', 'host'] as const;
/** One of {@linkcode PROFILE_TYPES}. */
export type ProfileType = (typeof PROFILE_TYPES)[number];

/** Reasoning effort levels, lowest to highest; a model accepts only the levels its catalog row lists. */
export const THINKING_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
/** One of {@linkcode THINKING_LEVELS}. */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** The wire protocols a model binding can speak. */
export const PROTOCOLS = ['geminiInteractions', 'geminiLive', 'openAi', 'decision'] as const;
/** One of {@linkcode PROTOCOLS}. */
export type Protocol = (typeof PROTOCOLS)[number];

/** The providers `createProvider` and `runDecision` can bind a model to. */
export const PROVIDERS = ['google', 'openrouter', 'local', 'typesafe'] as const;
/** One of {@linkcode PROVIDERS}. */
export type Provider = (typeof PROVIDERS)[number];

/** Turn pairs are handled by `createProvider`; decision pairs by `runDecision`. */
export const PROTOCOL_PROVIDERS = {
  geminiInteractions: ['google'],
  geminiLive: ['google'],
  openAi: ['openrouter', 'local'],
  decision: ['typesafe', 'openrouter'],
} as const satisfies Record<Protocol, readonly Provider[]>;

/** The protocols each profile type may bind; `host` profiles bind no model. */
export const PROFILE_TYPE_PROTOCOLS = {
  text: ['geminiInteractions', 'openAi'],
  image: ['geminiInteractions', 'openAi'],
  speech: ['geminiInteractions', 'openAi'],
  live: ['geminiLive'],
  decision: ['decision'],
  host: [],
} as const satisfies Record<ProfileType, readonly Protocol[]>;

/** The protocols a profile of type `T` may bind. */
export type ProfileTypeProtocol<T extends ProfileType> = (typeof PROFILE_TYPE_PROTOCOLS)[T][number];

/** The protocols a profile type may bind. */
export function protocolsForProfileType(type: ProfileType): readonly Protocol[] {
  return PROFILE_TYPE_PROTOCOLS[type];
}

/** True when a profile of this type may bind this protocol. */
export function isValidProfileProtocol(type: ProfileType, protocol: Protocol): boolean {
  return (PROFILE_TYPE_PROTOCOLS[type] as readonly string[]).includes(protocol);
}

/** A vault slot's name, chosen by the host. The profile names slots; the host fills them with keys. */
export type KeySlot = string;

/** Letters, digits, `-` and `_`, up to 32 characters, starting with a letter or digit. */
export const KEY_SLOT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** True when the value is a legal key slot name. */
export function isKeySlotName(value: unknown): value is KeySlot {
  return typeof value === 'string' && KEY_SLOT_NAME.test(value);
}

/** The host-filled keys by slot name; a slot with no key is `undefined`. */
export type KeyVault = Readonly<Record<KeySlot, string | undefined>>;

/** The kinds of media a model can take as input. */
export const MEDIA_INPUT_KIND_VALUES = ['image', 'audio', 'video', 'document'] as const;
/** One of {@linkcode MEDIA_INPUT_KIND_VALUES}. */
export type MediaInputKind = (typeof MEDIA_INPUT_KIND_VALUES)[number];

/** Whether thought summaries are asked for (`auto`) or not (`none`). */
export const SUMMARY_MODES = ['auto', 'none'] as const;
/** One of {@linkcode SUMMARY_MODES}. */
export type SummaryMode = (typeof SUMMARY_MODES)[number];

/** Whether the provider call streams (`sse`) or is one buffered call. */
export const STREAM_MODES = ['sse', 'buffered'] as const;
/** One of {@linkcode STREAM_MODES}. */
export type StreamMode = (typeof STREAM_MODES)[number];

/** Audio encodings a speech profile can return. */
export const SPEECH_AUDIO_FORMATS = ['pcm', 'mp3'] as const;
/** One of {@linkcode SPEECH_AUDIO_FORMATS}. */
export type SpeechAudioFormat = (typeof SPEECH_AUDIO_FORMATS)[number];

/** What the user starting to speak does to a live model that is mid-reply. */
export const LIVE_ACTIVITY_HANDLINGS = ['START_OF_ACTIVITY_INTERRUPTS', 'NO_INTERRUPTION'] as const;
/** One of {@linkcode LIVE_ACTIVITY_HANDLINGS}. */
export type LiveActivityHandling = (typeof LIVE_ACTIVITY_HANDLINGS)[number];

/** How readily live voice detection decides the user has started speaking. */
export const LIVE_START_SENSITIVITIES = [
  'START_SENSITIVITY_LOW',
  'START_SENSITIVITY_HIGH',
] as const;
/** One of {@linkcode LIVE_START_SENSITIVITIES}. */
export type LiveStartSensitivity = (typeof LIVE_START_SENSITIVITIES)[number];

/** How readily live voice detection decides the user has stopped speaking. */
export const LIVE_END_SENSITIVITIES = ['END_SENSITIVITY_LOW', 'END_SENSITIVITY_HIGH'] as const;
/** One of {@linkcode LIVE_END_SENSITIVITIES}. */
export type LiveEndSensitivity = (typeof LIVE_END_SENSITIVITIES)[number];

/** What compaction counts against its token limit: the stored history or the next request's input. */
export const COMPACTION_METERS = ['history', 'input'] as const;
/** One of {@linkcode COMPACTION_METERS}. */
export type CompactionMeter = (typeof COMPACTION_METERS)[number];

/** Whether compaction runs before or after a turn. */
export const COMPACTION_TIMINGS = ['before', 'after'] as const;
/** One of {@linkcode COMPACTION_TIMINGS}. */
export type CompactionTiming = (typeof COMPACTION_TIMINGS)[number];

/**
 * - `compacted`: a summary replaced the compacted messages.
 * - `deferred`: the compactor failed and the history still fits `maxTokens`, so it is kept whole.
 * - `dropped`: the compactor failed over `maxTokens`, so the compacted messages were dropped.
 */
export const COMPACTION_OUTCOMES = ['compacted', 'deferred', 'dropped'] as const;
/** One of {@linkcode COMPACTION_OUTCOMES}. */
export type CompactionOutcome = (typeof COMPACTION_OUTCOMES)[number];

/** Which part of the prompt is cached: the whole request (`automatic`) or the system instruction only (`system`). */
export const CACHE_MODES = ['automatic', 'system'] as const;
/** One of {@linkcode CACHE_MODES}. */
export type CacheMode = (typeof CACHE_MODES)[number];

/** How long a provider keeps a cached prompt. */
export const CACHE_TTLS = ['5m', '1h'] as const;
/** One of {@linkcode CACHE_TTLS}. */
export type CacheTtl = (typeof CACHE_TTLS)[number];

/** Why a turn stopped, as `done.stop.kind` reports it. */
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
/** One of {@linkcode TURN_STOP_KINDS}. */
export type TurnStopKind = (typeof TURN_STOP_KINDS)[number];

/** Every other stop resumes by another host path, or not at all. */
export const CONTINUE_STOP_KINDS = ['length', 'stream_incomplete', 'provider_error'] as const;
/** One of {@linkcode CONTINUE_STOP_KINDS}. */
export type ContinueStopKind = (typeof CONTINUE_STOP_KINDS)[number];

/** The points in a turn where a stage handler runs. */
export const TURN_STAGES = [
  'pre_turn',
  'pre_tool',
  'post_tool',
  'before_end',
  'post_turn',
] as const;
/** One of {@linkcode TURN_STAGES}. */
export type TurnStage = (typeof TURN_STAGES)[number];

const TURN_STAGE_SET = new Set<string>(TURN_STAGES);

/** True when the value names a turn stage. */
export function isTurnStage(value: unknown): value is TurnStage {
  return typeof value === 'string' && TURN_STAGE_SET.has(value);
}

/** Stages where an inject can land; the inject gate still applies. */
export const TURN_INJECT_STAGES = ['pre_turn', 'post_tool', 'before_end'] as const;
/** One of {@linkcode TURN_INJECT_STAGES}. */
export type TurnInjectStage = (typeof TURN_INJECT_STAGES)[number];

const TURN_INJECT_STAGE_SET = new Set<string>(TURN_INJECT_STAGES);

/** True when the value names a stage an inject can land in. */
export function isTurnInjectStage(value: unknown): value is TurnInjectStage {
  return typeof value === 'string' && TURN_INJECT_STAGE_SET.has(value);
}

/** `pre_tool` gates; not `awaiting_user_input`. */
export const TOOL_GATE_KINDS = ['confirmation', 'permission', 'auth'] as const;
/** One of {@linkcode TOOL_GATE_KINDS}. */
export type ToolGateKind = (typeof TOOL_GATE_KINDS)[number];

/** Why a refused gate settles: the user said no, walked away, or let it run out. */
export const TOOL_RESUME_CAUSES = ['declined', 'abandoned', 'expired'] as const;
/** One of {@linkcode TOOL_RESUME_CAUSES}. */
export type ToolResumeCause = (typeof TOOL_RESUME_CAUSES)[number];

const TOOL_GATE_KIND_SET = new Set<string>(TOOL_GATE_KINDS);

/** True when the value names a tool gate kind. */
export function isToolGateKind(value: unknown): value is ToolGateKind {
  return typeof value === 'string' && TOOL_GATE_KIND_SET.has(value);
}
/** The questions a turn can pause to ask the user. */
export const AWAITING_USER_INPUT_KINDS = ['confirm', 'choice', 'text'] as const;
/** One of {@linkcode AWAITING_USER_INPUT_KINDS}. */
export type AwaitingUserInputKind = (typeof AWAITING_USER_INPUT_KINDS)[number];

/** Why a stage handler's result was partly or wholly ignored. */
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
/** One of {@linkcode STAGE_APPLY_WARNING_CODES}. */
export type StageApplyWarningCode = (typeof STAGE_APPLY_WARNING_CODES)[number];

/** The `status` of a tool output that asks the user a question. */
export const AWAITING_USER_INPUT_STATUS = 'awaiting_user_input' as const;
/** Enforced by the kernel at resolve time. */
export const TOOL_LOAD_TIERS = ['T0', 'T1', 'T2'] as const;
/** One of {@linkcode TOOL_LOAD_TIERS}. */
export type ToolLoadTier = (typeof TOOL_LOAD_TIERS)[number];

/** The HTTP methods an `http` tool may use. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
/** One of {@linkcode HTTP_METHODS}. */
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** When remote tool auth is missing or expired. */
export const AUTH_UNAUTHENTICATED_POLICIES = ['gate', 'report_to_model'] as const;
/** One of {@linkcode AUTH_UNAUTHENTICATED_POLICIES}. */
export type AuthUnauthenticatedPolicy = (typeof AUTH_UNAUTHENTICATED_POLICIES)[number];

/** The kinds of tool a profile can list. */
export const TOOL_TYPES = ['builtin', 'function', 'http', 'mcp', 'agent'] as const;

/** How much a tool can change: nothing, data, or irreversibly. */
export const TOOL_ACCESS = ['read-only', 'read-write', 'destructive'] as const;
/** One of {@linkcode TOOL_ACCESS}. */
export type ToolAccess = (typeof TOOL_ACCESS)[number];

/** When the user must approve a tool call: never, once per session, or every call. */
export const TOOL_PERMISSION = ['auto', 'session_consent', 'always_confirm'] as const;
/** One of {@linkcode TOOL_PERMISSION}. */
export type ToolPermission = (typeof TOOL_PERMISSION)[number];

/** The credential shapes a remote tool can authenticate with. */
export const TOOL_AUTH_TYPES = ['bearer', 'api_key', 'oauth2'] as const;
/** One of {@linkcode TOOL_AUTH_TYPES}. */
export type ToolAuthType = (typeof TOOL_AUTH_TYPES)[number];

/** Adds UI-only `none`, which omits auth at compile time. */
export const PLAYGROUND_AUTH_TYPES = ['none', ...TOOL_AUTH_TYPES] as const;
/** One of {@linkcode PLAYGROUND_AUTH_TYPES}. */
export type PlaygroundAuthType = (typeof PLAYGROUND_AUTH_TYPES)[number];

/** One of {@linkcode TOOL_TYPES}. */
export type ToolType = (typeof TOOL_TYPES)[number];
/** A tool type the host defines, which is every type but `builtin`. */
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

/** The MIME types a text profile's `accept` entries may list. */
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

/** The MIME types a voice profile's `accept` entries may list. */
export const VOICE_ACCEPT_MIMES: readonly string[] = ['audio/*', ...mimesOf('audio')];

/** The providers that can serve a protocol. */
export function providersFor(protocol: Protocol): readonly Provider[] {
  return PROTOCOL_PROVIDERS[protocol];
}

/** The protocols a provider can serve. */
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

/** What the catalog records about one profile field: its type, description, options and when it applies. */
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

/** Turns a key path into its catalog path, replacing host-chosen map keys with `*`. */
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
  id: field(
    'string',
    'The name this profile is registered and looked up by; registering the same id again replaces it.',
  ),
  type: field(
    "'text' | 'image' | 'speech' | 'live' | 'decision' | 'host'",
    'What kind of agent this is, and so what each call gives back: text, image, speech, live, decision or host.',
    PROFILE_TYPES,
    {
      text: 'A chat or task agent. Each turn the model answers in text, or in JSON when outputs ask for a structured reply, and can call tools on the way.',
      image: 'Makes pictures from a prompt, in the shape, size and format the image block sets.',
      speech:
        'Gives your app a voice. Each turn reads text aloud in the voice the speech block names.',
      live: 'For talking in real time. One continuous voice and video session over Gemini Live, rather than separate turns.',
      decision:
        'For when your app needs a judgement, not a reply. It answers questions about a JSON state, each with a choice, a score or a number.',
      host: 'A governed passthrough to your tool registry, with no model. It calls MCP, HTTP and in-app function tools under the same permissions and traces as any agent, guarded by sanitizeInput, redactSensitive and network.',
    },
  ),
  identity: field(
    '{ handle, system?, systemByRole? }',
    "The agent's display name and the system instruction it is given.",
  ),
  'identity.handle': field(
    'string',
    "The agent's display name for hosts and users (the model never sees it), and the systemByRole entry a turn gets when it names no known role.",
  ),
  'identity.system': field(
    'string | Array<string | { private: string }>',
    'The instruction the model gets on every turn unless a systemByRole entry replaces it; OpenRouter image profiles send it only with includeText on. Mark what must not leak as { private: text }; only that is guarded. With none, the whole prompt is.',
  ),
  'identity.systemByRole': field(
    'Record<string, string | Array<string | { private: string }>>',
    'Other system instructions, picked by the role a turn names.',
  ),
  'identity.systemByRole.*': field(
    'string | Array<string | { private: string }>',
    'The instruction that replaces identity.system when a turn names this role.',
  ),
  models: field(
    'Record<ModelId, ModelBinding | DecisionModelBinding>',
    'The models this profile can use, each under a name you choose.',
  ),
  'models.*': field(
    'ModelBinding | DecisionModelBinding',
    'One model: how to reach it and the settings sent with it.',
  ),
  'models.*.protocol': field(
    unionType(PROTOCOLS),
    'The API this model is called through: Gemini, OpenAI-style, or the Decisions API.',
    PROTOCOLS,
    {
      geminiInteractions: "Google's Gemini Interactions API.",
      geminiLive: "Google's Gemini Live streaming API.",
      openAi: 'The OpenAI-style API, served by OpenRouter or a local server.',
      decision: 'The typed Decisions API, served by TypeSafe or OpenRouter.',
    },
  ),
  'models.*.provider': field(
    unionType(PROVIDERS),
    'Who serves the model: Google, OpenRouter, a local server, or TypeSafe.',
    PROVIDERS,
    {
      google: "Google's Gemini API.",
      openrouter: 'OpenRouter, which routes to many model vendors.',
      local: 'A server you run (Ollama, llama.cpp, vLLM), for text profiles only.',
      typesafe: 'TypeSafe, serving its native decision models.',
    },
  ),
  'models.*.apiId': field('string', "The model's name at the provider."),
  'models.*.timeoutMs': field(
    'number',
    'How long a decision waits for its provider, in milliseconds. Omit for no timeout.',
  ),
  decision: field(
    '{ contract: DecisionContractId }',
    'Names the host decision this profile makes.',
  ),
  'decision.contract': field(
    'string',
    "Your name for this decision, recorded on its traces; it isn't sent to the model or checked against the questions.",
  ),
  'models.*.efforts': field(
    'Record<string, ThinkingLevel>',
    'Named thinking levels for this model, which a turn can pick between when allowEffortSelect is on; local models, speech and OpenRouter image without includeText ignore them.',
  ),
  'models.*.efforts.*': field(
    unionType(THINKING_LEVELS),
    'The thinking level sent to the provider for this name.',
    THINKING_LEVELS,
    {
      none: 'No thinking; OpenRouter only.',
      minimal: 'The least thinking.',
      low: 'Light thinking.',
      medium: 'Moderate thinking.',
      high: 'Heavy thinking.',
      xhigh: 'Heavier thinking; OpenRouter only.',
      max: 'The most thinking the model supports; OpenRouter only.',
    },
  ),
  'models.*.defaultEffort': field('string', "The effort a turn gets when it doesn't pick one."),
  'models.*.allowEffortSelect': field(
    'boolean',
    'Lets a turn pick an effort; needs two or more efforts.',
  ),
  'models.*.summaries': field(
    'boolean',
    'Asks Gemini Interactions for summaries of its thinking; on OpenRouter, off only hides thoughts, and other providers ignore it.',
  ),
  'models.*.maxOutputTokens': field(
    'number',
    'The most tokens the model may write in one reply; OpenRouter speech, and OpenRouter image without includeText, never send it.',
  ),
  'models.*.temperature': field(
    'number',
    "How varied the model's wording is; higher is more random. OpenRouter speech, and OpenRouter image without includeText, never send it.",
  ),
  'models.*.builtInTools': field(
    'BuiltinToolId[]',
    "The provider's own tools, such as Google Search, this model may use; each must be registered as a builtin tool.",
  ),
  'models.*.key': field(
    'KeySlot',
    "The key slot this model's calls use, ahead of the profile's key; a local model uses only its own.",
  ),
  'models.*.fallbackKey': field(
    'KeySlot',
    "The key slot this model's calls retry on when its key is refused for quota, ahead of the profile's fallbackKey; a local model uses only its own.",
  ),
  'models.*.compaction': field(
    'CompactionSpec',
    'Summarises older history once it grows past a threshold; a text agent can write its own summary, other types must name a compaction profile.',
  ),
  'models.*.compaction.maxTokens': field('number', 'The token budget compactAt is a fraction of.'),
  'models.*.compaction.trigger': field(
    '(ctx: CompactionTriggerContext) => boolean | Promise<boolean>',
    'Your function that decides when to compact, in place of compactAt and maxTokens.',
  ),
  'models.*.compaction.compactAt': field(
    'number',
    'The fraction of maxTokens, between 0 and 1, at which compaction starts, unless trigger decides.',
  ),
  'models.*.compaction.previousExchanges': field(
    'number',
    'How much recent history compaction keeps: a number of exchanges (1 or more), a fraction of maxTokens below compactAt, or 0 to compact it all.',
  ),
  'models.*.compaction.profile': {
    ...field(
      'ProfileId',
      'The text profile that writes the summary; register it before this one. Leave it out and a text agent summarises its own history, with its own instructions and model and no tools. Unless the turn passes compactionProvider, it must use the same provider and protocol as a text agent.',
    ),
    unset: 'The agent itself',
  },
  'models.*.compaction.timing': field(
    unionType(COMPACTION_TIMINGS),
    'Whether the kernel compacts before the turn or tells the host to compact after it.',
    COMPACTION_TIMINGS,
    {
      before: 'The kernel compacts before the turn runs.',
      after: "The turn's done event says compaction is due, and the host runs it.",
    },
  ),
  'models.*.compaction.meter': field(
    unionType(COMPACTION_METERS),
    'What the threshold counts.',
    COMPACTION_METERS,
    {
      history: 'Tokens in the earlier conversation.',
      input:
        'The prompt tokens the provider reported for the last call, or the count the host passes in.',
    },
  ),
  'models.*.cache': field(
    'CacheSpec',
    'Prompt caching on OpenRouter text profiles: reuses the start of a prompt it has already seen. With the canary on, the system instruction changes every turn, so a cache is reused only within a turn.',
  ),
  'models.*.cache.mode': field(
    unionType(CACHE_MODES),
    'Which part of the prompt is cached.',
    CACHE_MODES,
    {
      automatic: 'The whole request, so the cached part grows with the conversation.',
      system: "The system instruction only, with the kernel's notes after it.",
    },
  ),
  'models.*.cache.ttl': field(
    unionType(CACHE_TTLS),
    'How long a cached prompt lasts.',
    CACHE_TTLS,
    {
      '5m': 'Five minutes.',
      '1h': 'One hour; writing the cache costs more, which pays off in long sessions.',
    },
  ),
  'models.*.store': field(
    'boolean',
    'Whether Google stores the interaction (Gemini Interactions only); a turn can override it.',
  ),
  'models.*.persistViaInteractionId': field(
    'boolean',
    'Whether Google builds the context from its stored interaction (true) or every call sends the history the host passes plus the steps of this turn (false); Gemini Interactions only, and true needs storing on.',
  ),
  'models.*.server': field(
    'string',
    "Which local server runs the model (ollama, vllm, …), recorded on traces; it doesn't change where requests go.",
  ),
  defaultModel: field('ModelId', "The model a turn gets when it doesn't pick one."),
  allowModelSelect: field('boolean', 'Lets a turn pick a model; needs two or more models.'),
  maxSteps: field(
    'number',
    'The most model calls one turn may make while using tools, counted afresh for each rewrite; 1 runs the tools asked for but never sends their results back. Live sessions ignore it.',
  ),
  key: field(
    'KeySlot',
    'The key slot a hosted model uses when it has no key of its own; local models never use it.',
  ),
  fallbackKey: field(
    'KeySlot',
    'The key slot a hosted call retries on when its key is refused for quota. Off unless set.',
  ),
  tools: field(
    '{ allow: ToolId[]; t1Policy?; t2Loader? }',
    'Which of your registered tools this profile may use, and how they load; built-in tools are turned on per model.',
  ),
  'tools.allow': field(
    'ToolId[]',
    "Your registered tools this agent may use; the provider's own tools go on the model's builtInTools instead.",
  ),
  'tools.t1Policy': field(
    '(ctx) => ToolId[] | Promise<ToolId[]>',
    'Your function that picks, at the start of each turn, which T1 tools to load; it loads no other tier.',
  ),
  'tools.t2Loader': field(
    'ToolId',
    'The function tool the model calls to load T2 tools; it must be in allow and return { loaded: ToolId[] }. One id it may not load fails the whole load; ids off the turn path are skipped.',
  ),
  inputs: field(
    'ProfileInputsSpec | DecisionInputsSpec',
    'What a turn may send (text, files, voice, choices), or on a decision, the state it reads.',
  ),
  'inputs.state': field("'json'", 'A decision reads JSON state, passed on each call.', ['json']),
  'inputs.maxStateBytes': field(
    'number',
    'The largest state, in bytes, a decision call may send; larger state is refused before it leaves your process.',
  ),
  'inputs.text': field('boolean', 'Whether a turn may send text.'),
  'inputs.attachments': field('{ accept: string[] }', 'Lets turns send files.'),
  'inputs.attachments.accept': field(
    'string[]',
    'The file types a turn may send, where type/* matches a whole family; image profiles take only images, video and PDF.',
    ATTACHMENT_ACCEPT_MIMES,
    "Types the kernel knows; a listed type it doesn't know is refused when a turn sends it.",
  ),
  'inputs.voice': field('{ accept: string[] }', 'Lets turns send voice clips.'),
  'inputs.voice.accept': field(
    'string[]',
    'The audio types a voice clip may be; audio/* matches them all.',
    VOICE_ACCEPT_MIMES,
    'Audio types the kernel knows.',
  ),
  'inputs.maxFiles': field(
    'number',
    'The most files and voice clips one turn may send, counted together.',
  ),
  'inputs.maxBytes': field('number', 'The largest file or clip, in bytes, a turn may send inline.'),
  'inputs.maxTurnBytes': field(
    'number',
    'The most bytes one turn may send inline across all its files and clips.',
  ),
  'inputs.limitsByMime': field(
    'Record<string, number>',
    'Size limits by file type that replace maxBytes for those types.',
  ),
  'inputs.limitsByMime.*': field(
    'number',
    'The largest file of this type (or type/* family), in bytes, a turn may send inline.',
  ),
  'inputs.slots': field(
    'Record<string, string[]>',
    'Named choices a turn can make, such as language, each with its allowed values.',
  ),
  'inputs.slots.*': field(
    'string[]',
    'The values a turn may choose for this slot; any other is refused.',
  ),
  outputs: field(
    'ProfileOutputsSpec',
    'The shape of the reply, how it is checked, and how it streams.',
  ),
  'outputs.structured': field(
    'StructuredSchemaId | StructuredBySlot | null',
    'The registered JSON schema the reply must follow, which can vary by slot; register it before the profile.',
  ),
  image: field('ProfileImageSpec', 'Settings for the images this profile makes.'),
  'image.aspectRatio': field('string', 'The shape of generated images, such as 16:9.'),
  'image.resolution': field('string', 'How detailed generated images are, such as 1K, 2K or 4K.'),
  'image.mimeType': field(
    'string',
    'The file type of generated images; OpenRouter takes png, jpeg or webp and uses png for anything else.',
  ),
  'image.quality': field(
    'string',
    'How much effort the model spends on each image; OpenRouter takes auto, low, medium or high, and Google refuses it.',
  ),
  'image.background': field(
    'string',
    'The background of generated images; OpenRouter takes auto, transparent or opaque, and Google refuses it.',
  ),
  'image.n': field(
    'number',
    'How many images one request makes; only OpenRouter `/images` takes it.',
  ),
  'image.seed': field(
    'number',
    'A seed for repeatable images; OpenRouter `/images` and Google take it, where the model honours it.',
  ),
  'image.outputCompression': field(
    'number',
    'Compression from 0 to 100 for jpeg and webp images; OpenRouter only.',
  ),
  'image.references': field(
    'Array<TurnBlob | TurnMediaRef>',
    'Reference images sent with every turn, ahead of the ones the user attaches; each is bytes (`data`) or a link (`uri`). OpenRouter `/images` takes only http(s) links, and with includeText no links at all.',
  ),
  'image.includeText': field(
    'boolean',
    'Whether the model may write text alongside its images; on OpenRouter this also sends the system instruction and history.',
  ),
  speech: field('ProfileSpeechSpec', 'Settings for the audio this profile speaks.'),
  'speech.voice': field('string', 'The voice the speech is read in.'),
  'speech.format': field(
    unionType(SPEECH_AUDIO_FORMATS),
    'The audio format asked of the provider.',
    SPEECH_AUDIO_FORMATS,
    {
      pcm: 'Uncompressed audio, delivered as WAV.',
      mp3: 'Compressed audio; OpenRouter only.',
    },
  ),
  live: field('ProfileLiveSpec', 'Settings for the realtime voice and video session.'),
  'live.ingress': field('LiveIngressSpec', 'Which channels the session accepts from the user.'),
  'live.ingress.audio': field('boolean', 'Whether the session accepts microphone audio.'),
  'live.ingress.video': field('boolean', 'Whether the session accepts camera frames.'),
  'live.ingress.text': field('boolean', 'Whether the session accepts typed text.'),
  'live.voice': field(
    'string',
    'The voice the model speaks in.',
    GOOGLE_SPEECH_VOICES,
    "Google's voice names; any other name is sent as written.",
  ),
  'live.vad': field(
    'LiveVadSpec',
    'How the session detects when the user starts and stops speaking.',
  ),
  'live.vad.activityHandling': field(
    unionType(LIVE_ACTIVITY_HANDLINGS),
    "Whether the user speaking interrupts the model's reply.",
    LIVE_ACTIVITY_HANDLINGS,
    {
      START_OF_ACTIVITY_INTERRUPTS: 'The user speaking cuts the reply off.',
      NO_INTERRUPTION: 'The model finishes its reply.',
    },
  ),
  'live.vad.startSensitivity': field(
    unionType(LIVE_START_SENSITIVITIES),
    'How readily the session decides the user has started speaking.',
    LIVE_START_SENSITIVITIES,
    {
      START_SENSITIVITY_LOW: 'Detects the start of speech less often.',
      START_SENSITIVITY_HIGH: 'Detects the start of speech more often.',
    },
  ),
  'live.vad.endSensitivity': field(
    unionType(LIVE_END_SENSITIVITIES),
    'How readily the session decides the user has stopped speaking.',
    LIVE_END_SENSITIVITIES,
    {
      END_SENSITIVITY_LOW: 'Ends speech less often, waiting through pauses.',
      END_SENSITIVITY_HIGH: 'Ends speech more often, at shorter pauses.',
    },
  ),
  'live.vad.prefixPaddingMs': field(
    'number',
    'How long speech must last, in milliseconds, before it counts as the user starting to speak.',
  ),
  'live.vad.silenceDurationMs': field(
    'number',
    "How long a silence, in milliseconds, ends the user's speech.",
  ),
  'live.sessionResumption': field(
    'boolean',
    'Whether Google sends resume handles, which the host can pass to a new session to carry this one on.',
  ),
  'live.contextCompression': field(
    'LiveContextCompressionSpec',
    "Trims the session's context once it grows past the trigger.",
  ),
  'live.contextCompression.triggerTokens': field(
    'number',
    'The context size, in tokens, that starts trimming.',
  ),
  'live.contextCompression.slidingWindow': field(
    'LiveSlidingWindowSpec',
    'Trims by dropping the oldest turns; the system instruction stays.',
  ),
  'live.contextCompression.slidingWindow.targetTokens': field(
    'number',
    'The context size, in tokens, to trim down to; below the trigger.',
  ),
  'live.transcription': field('LiveTranscriptionSpec', "Text transcripts of the session's speech."),
  'live.transcription.input': field('boolean', "Whether the user's speech is transcribed."),
  'live.transcription.output': field(
    'boolean',
    "Whether the model's speech is transcribed; always on while the canary or egress.enforce is, since they read the transcript.",
  ),
  'outputs.validation': field(
    'ProfileValidationSpec',
    'Your checks on a structured reply, and how many rewrites a failure gets.',
  ),
  'outputs.validation.fields': field(
    'Record<string, ProfileValidator>',
    'Your checks, each keyed by a dotted path into the structured reply, such as diagram.mermaid; a path no structured schema reaches is refused when the profile registers.',
  ),
  'outputs.validation.fields.*': field(
    '(candidate: unknown, slots?: Record<string, string>) => ValidationResult | Promise<ValidationResult>',
    'Your check on this part of the reply, reached through object properties only; a failure sends its error back to the model to rewrite while retries remain.',
  ),
  'outputs.validation.maxRetries': field(
    'number',
    "How many times the model may rewrite a reply that fails your checks or the schema's required keys before it goes out as it is; text already streamed stays. The larger of this and egress.maxRetries applies to both.",
  ),
  'outputs.streaming': field(
    'ProfileStreamingSpec',
    'How the reply reaches the host, and whether its thinking does.',
  ),
  'outputs.streaming.mode': field(
    unionType(STREAM_MODES),
    'Whether the provider call streams.',
    STREAM_MODES,
    {
      sse: 'Events arrive as the model writes; OpenRouter image and speech always answer in one piece.',
      buffered: 'One non-streaming call; its events arrive together when it answers.',
    },
  ),
  'outputs.streaming.streamThoughts': field(
    'boolean',
    "Whether the model's thinking reaches the host.",
  ),
  turnBehaviour: field(
    'ProfileTurnBehaviourSpec',
    'Whether a reply that stopped early can be continued, and whether a running turn can be steered.',
  ),
  'turnBehaviour.resumption': field(
    'ProfileTurnResumptionSpec',
    'Continuing a reply that stopped early; live uses sessionResumption instead.',
  ),
  'turnBehaviour.resumption.allowContinue': field(
    'ContinueStopKind[]',
    "Which early stops the host offers the user a Continue for; the kernel doesn't refuse a continue after other stops.",
    CONTINUE_STOP_KINDS,
    {
      length: 'The reply hit the output token limit.',
      stream_incomplete: 'The connection dropped mid-reply.',
      provider_error: 'The provider returned an error or timed out.',
    },
  ),
  'turnBehaviour.resumption.autoContinue': field(
    'ContinueStopKind[]',
    'Which early stops the host continues without asking; each must also be in allowContinue.',
    CONTINUE_STOP_KINDS,
    {
      length: 'The reply hit the output token limit.',
      stream_incomplete: 'The connection dropped mid-reply.',
      provider_error: 'The provider returned an error or timed out.',
    },
  ),
  'turnBehaviour.resumption.maxContinues': field(
    'number',
    'How many times one reply may be continued; once set, each continue must say which one it is.',
  ),
  'turnBehaviour.allowSteering': field(
    'boolean',
    'Whether your onStage hook may add messages to a running turn; text profiles also offer the user a way to steer.',
  ),
  guardrails: field('ProfileGuardrailsSpec', "Protections for this profile's turns."),
  'guardrails.quota': field(
    'QuotaGuardrailSpec',
    "A daily turn limit your server middleware enforces with takeSlot; runTurn itself doesn't count turns.",
  ),
  'guardrails.quota.perDay': field(
    'number',
    'Turns each client IP may run on this profile per UTC day, one at a time; counts live in the process, and a loopback caller is not counted.',
  ),
  'guardrails.canary': field(
    'boolean',
    'Plants a secret token in the system instruction and stops the reply if the model repeats it; a thought that repeats it has it cut out instead.',
  ),
  'guardrails.promptEcho': field(
    'boolean',
    'With the canary on, also stops a reply that repeats 12 words in a row of the private system instruction. On by default; wrap the private lines as { private: text } so the plain ones may be quoted, or turn it off when the whole instruction may be.',
  ),
  'guardrails.sanitizeInput': field(
    'boolean',
    "Replaces prompt-injection text in user input, slots, history, tool results and the turn's own system text before the model sees it.",
  ),
  'guardrails.redactSensitive': field(
    'boolean | SensitiveSwitches',
    "Replaces credentials and personal data in user input, slots, history, tool results and the turn's own system text before the model sees them. true (the default) covers every group, false none; an object turns groups off one by one.",
  ),
  'guardrails.redactSensitive.ids': field('boolean', 'US SSN, ITIN and EIN numbers.'),
  'guardrails.redactSensitive.financial': field('boolean', 'IBANs and card numbers.'),
  'guardrails.redactSensitive.network': field('boolean', 'IPv4 and IPv6 addresses.'),
  'guardrails.redactSensitive.credentials': field(
    'boolean',
    'Known API key and token formats (AWS, Google, OpenAI, Anthropic, OpenRouter, GitHub, Slack), bearer tokens and PEM private keys.',
  ),
  'guardrails.egress': field(
    'ProfileEgressSpec',
    'Your check on the reply before the user sees it.',
  ),
  'guardrails.egress.enforce': field(
    'EgressEnforcer',
    'Your own check on the reply, run as it streams and when it ends. Return allow, flag (log only), redact (your text replaces what is not yet shown) or block (see onBlock); a block or redact holds the rest of the stream, and a throw counts as a block. Set exactly one of this and checks.',
  ),
  'guardrails.egress.checks': field(
    'boolean | EgressChecks',
    'The bundled checks on the reply, blocking on what they find. true runs each at its default, false none but the system-prompt leak checks, and an object switches the ones it names. Set exactly one of this and enforce.',
  ),
  'guardrails.egress.checks.sensitive': field(
    'boolean | SensitiveSwitches',
    'Credentials and personal data in the reply, by group. Every group but network by default: an address in a reply is not a secret.',
  ),
  'guardrails.egress.checks.sensitive.ids': field('boolean', 'US SSN, ITIN and EIN numbers.'),
  'guardrails.egress.checks.sensitive.financial': field('boolean', 'IBANs and card numbers.'),
  'guardrails.egress.checks.sensitive.network': field('boolean', 'IPv4 and IPv6 addresses.'),
  'guardrails.egress.checks.sensitive.credentials': field(
    'boolean',
    'Known API key and token formats (AWS, Google, OpenAI, Anthropic, OpenRouter, GitHub, Slack), bearer tokens and PEM private keys.',
  ),
  'guardrails.egress.checks.boundary': field(
    'boolean',
    'The markers the kernel puts around user data, and the default canary note, repeated in the reply.',
  ),
  'guardrails.egress.checks.injection': field(
    'boolean',
    'Prompt-injection phrasing in the reply, as written or disguised.',
  ),
  'guardrails.egress.checks.images': field(
    'boolean | UrlCheck',
    'Images in the reply that load a URL the model was not given, which would send data off the device with no click.',
  ),
  'guardrails.egress.checks.images.hosts': field(
    'string[]',
    'Hostnames whose images load whatever their URL, such as your own CDN.',
  ),
  'guardrails.egress.checks.images.fromTools': field(
    'boolean',
    'Whether a URL a tool returned counts as given. Off keeps only what the system prompt, the user and history gave.',
  ),
  'guardrails.egress.checks.links': field(
    'boolean | UrlCheck',
    'Links in the reply to a URL the model was not given. Turn it on when your app unfurls links into previews.',
  ),
  'guardrails.egress.checks.links.hosts': field(
    'string[]',
    'Hostnames whose links pass whatever their URL; the images hosts pass too.',
  ),
  'guardrails.egress.checks.links.fromTools': field(
    'boolean',
    'Whether a URL a tool returned counts as given. Off keeps only what the system prompt, the user and history gave.',
  ),
  'guardrails.egress.onBlock': field(
    unionType(EGRESS_ON_BLOCK),
    'What happens when enforce or checks blocks the reply.',
    EGRESS_ON_BLOCK,
    {
      reject_to_agent:
        'The model reads why and rewrites the reply, up to maxRetries times; once retries run out, the reply is withheld and the turn ends with a safety error. Live never rewrites: it withholds at once.',
      refuse_to_user:
        'The user sees the egress.refusal wording in place of the reply, and the turn ends.',
    },
  ),
  'guardrails.egress.maxRetries': field(
    'number',
    'How many times the model may rewrite a blocked reply; the larger of this and outputs.validation.maxRetries applies to both. Live ignores it.',
  ),
  'guardrails.egress.holdback': field(
    'number',
    'How many characters the stream holds back so your own enforce can catch text split across chunks (default 256; 96 on Live). Only for your own enforce: the bundled checks hold exactly what they need, and setting it with them is refused.',
  ),
  'guardrails.network': field(
    'NetworkGuardrailSpec',
    'Which addresses your HTTP and MCP tools may reach.',
  ),
  'guardrails.network.allowPrivateNetworks': field(
    'boolean',
    'Lets tools reach localhost and private network addresses, for local development.',
  ),
  'guardrails.network.allowedHosts': field(
    'string[]',
    "Hostnames tools may reach even when they resolve to a private address; public hosts don't need listing. Names are resolved only when the host passes resolveHost.",
  ),
  'guardrails.network.allowedSchemes': field('string[]', 'The URL schemes tools may use.'),
  'guardrails.taint': field(
    'TaintGuardrailSpec',
    "What tools may still do after the turn reads a remote tool's result.",
  ),
  'guardrails.taint.afterRemoteRead': field(
    unionType(TAINT_GATES),
    "Which tool calls are refused, by each tool's access, once the turn has read a remote tool's result.",
    TAINT_GATES,
    {
      off: 'None; risky calls are only logged.',
      destructive: 'Destructive calls.',
      write: 'Read-write and destructive calls.',
    },
  ),
  'guardrails.disclosure': field(
    '{ enforce: DecisionDisclosureEnforcer }',
    'Your check on the state before a decision sends it to the model.',
  ),
  'guardrails.disclosure.enforce': field(
    '(state, context) => DecisionDisclosureVerdict | Promise<DecisionDisclosureVerdict>',
    'Your function that allows or blocks the state before it is sent.',
  ),
  lexicon: field(
    'LexiconOverrides',
    "This profile's own wording for error lines, notices and notes to the model, by lexicon key.",
  ),
  'lexicon.*': field(
    'string',
    'The wording for this lexicon key; canary.bind_note must keep its {canary} placeholder.',
  ),
  observability: field(
    'ProfileObservabilitySpec',
    "Where this profile's traces go and what they keep.",
  ),
  'observability.writeTo': field(
    'false | string | TraceSink',
    'Where traces are written: a destination id you registered, your own writer, or false for none; an unregistered id fails the turn before it starts, and a sink passed straight to runTurn replaces it.',
  ),
  'observability.sampleRate': field(
    'number',
    'The share of traces kept, from 0 to 1, each kept or dropped whole; a sink passed straight to runTurn keeps every trace.',
  ),
  'observability.include': field('TraceIncludeSpec', 'Which optional parts of a trace are kept.'),
  'observability.include.upstreamLog': field(
    'boolean',
    'Keeps each row the provider sent back, scrubbed, as it arrived, with media bytes replaced by their sha256.',
  ),
  'observability.include.outboundWire': field(
    'boolean',
    'Keeps each request body sent to the provider, scrubbed.',
  ),
  'observability.include.evidenceRaw': field(
    'boolean',
    "Keeps the provider's raw payload on grounding results such as search citations; upstreamLog rows keep their own copy.",
  ),
  'observability.include.usage': field(
    'boolean',
    'Keeps token counts and other usage figures on spans; upstreamLog rows keep their own.',
  ),
  'observability.include.guardrailDecisions': field('boolean', 'Keeps each guardrail decision.'),
  'observability.include.guardrailMatchPreview': field(
    'boolean',
    "Keeps the exact text each guardrail matched, unscrubbed, on the trace and the host's event stream; for debugging only.",
  ),
  'observability.resource': field(
    'Record<string, TraceAttributeValue>',
    'Attributes stamped on every trace, such as service.name.',
  ),
  'observability.scrub': field(
    'TraceScrubSpec',
    "What is removed from stored traces, separately from the turn's guardrails.",
  ),
  'observability.scrub.sensitive': field(
    'boolean',
    'Removes credentials and personal data from stored traces.',
  ),
  'observability.scrub.injection': field(
    'boolean',
    'Removes prompt-injection text, found by the built-in pattern detector, from stored traces.',
  ),
  'observability.scrub.canary': field('boolean', 'Removes the canary token from stored traces.'),
  'observability.retainForDays': field(
    'number',
    'How many days each trace file is kept, by its UTC day, removed on the next write; 0 or less keeps them forever.',
  ),
  'observability.rotateAfterMiB': field(
    'number',
    'File size in MiB at which a file-based destination starts a new file, handed to every destination with the record. Default 32.',
  ),
  'observability.onWriteError': field(
    '(err: unknown) => void',
    "Your function called when a trace can't be built or written; the turn carries on, and a destination's own error handler takes priority. An unregistered writeTo id is a config error instead.",
  ),
});

const TOOL_TYPE_FIELD = field(unionType(TOOL_TYPES), 'How the tool runs.', TOOL_TYPES, {
  builtin: "The provider's own tool, such as Google Search, run by the provider.",
  function: 'Your handler runs it.',
  http: 'The kernel calls your HTTP endpoint.',
  mcp: 'The kernel calls a tool on a remote MCP server.',
  agent: 'The kernel runs one turn of another registered agent and returns its reply.',
});

const CREDENTIAL_KINDS = {
  bearer: 'A token; a secret typed in at the prompt becomes a bearer token.',
  ['api_' + 'key']: 'An API key; a secret typed in at the prompt becomes an API key.',
  oauth2: 'An OAuth sign-in; the host supplies the token.',
};

/** The catalog of the fields `registerTool` takes, keyed by path like `PROFILE_FIELDS`. */
export const EXTRA_FIELDS: Record<string, FieldMeta> = {
  /** Playground / UI path — avoids collision with profile `type` in fieldMeta(). */
  'registerTool.type': TOOL_TYPE_FIELD,
  name: field(
    'string',
    "The tool's id, which profiles list in tools.allow (or a model's builtInTools) and the model calls a custom tool by.",
  ),
  description: field('string', 'Tells the model what the tool does (custom tools only).'),
  input: field(
    'ZodSchema',
    "The Zod schema for the tool's arguments, sent to the model and checked on every call.",
  ),
  output: field(
    'ZodSchema',
    "The Zod schema every result the tool returns must match; the kernel's own not-signed-in note is not checked.",
  ),
  handler: field(
    'ToolHandler',
    'Your function that runs the tool; it can also yield progress as it goes.',
  ),
  endpoint: field(
    'string',
    'The URL the tool calls, with {name} placeholders for mapping.pathParams; the scheme and host must be written out.',
  ),
  method: field(
    unionType(HTTP_METHODS),
    'The HTTP method; every method but GET sends a JSON body.',
    HTTP_METHODS,
  ),
  headers: field(
    'Record<string, string>',
    "Headers sent with every request to the tool's own origin, never once a redirect leaves it.",
  ),
  mapping: field(
    '{ pathParams?, queryParams?, bodyParam? }',
    'Where each argument goes in the request.',
  ),
  'mapping.pathParams': field(
    'string[]',
    'Arguments that fill the {name} placeholders in the endpoint.',
  ),
  'mapping.queryParams': field('string[]', 'Arguments added to the query string.'),
  'mapping.bodyParam': field(
    'string',
    'The one argument sent as the whole JSON body; without it, a method other than GET sends every argument the path and query leave unused.',
  ),
  serverUrl: field('string', "The MCP server's URL."),
  mcpToolName: field('string', "The tool's name on the MCP server."),
  profile: field(
    'ProfileId',
    'The agent an agent tool runs: a text, image or speech profile, registered before this tool. Nothing it can call may stop on a gate.',
  ),
  maxCallsPerTurn: {
    ...field('number', 'How many times one turn of the calling agent may run this tool.'),
    unset: 'As many as its steps allow',
  },
  auth: {
    ...field('ToolAuthConfig', 'How the tool gets its credential.'),
    unset: 'No credential',
  },
  'auth.type': field(
    unionType(TOOL_AUTH_TYPES),
    "The kind of credential the tool expects, shown when a turn stops to ask for one; the header follows the stored credential's own kind.",
    TOOL_AUTH_TYPES,
    CREDENTIAL_KINDS,
  ),
  'auth.slot': field('string', 'Which of the credentials the turn passes in this tool uses.'),
  'auth.service': field(
    'string',
    'The service the person signs in to, as they know it, named when a turn stops to ask for a credential.',
  ),
  'auth.headerName': {
    ...field(
      'string',
      "The header the credential goes in; an API key's own headerName comes first.",
    ),
    unset: 'Authorization',
  },
  'auth.headerPrefix': {
    ...field(
      'string',
      "Text put before the credential in the header; an API key's own headerPrefix comes first.",
    ),
    unset: '"Bearer " for tokens, nothing for API keys',
  },
  'auth.onUnauthenticated': {
    ...field(
      unionType(AUTH_UNAUTHENTICATED_POLICIES),
      "What happens when the credential is missing, expired, can't be refreshed or is refused by the service.",
      AUTH_UNAUTHENTICATED_POLICIES,
      {
        gate: 'The turn stops and asks the host for a credential.',
        report_to_model: "The model is told the tool isn't signed in, and the turn goes on.",
      },
    ),
    unset: 'gate',
  },
  'auth.scopes': field(
    'string[]',
    'The OAuth scopes the tool needs, shown when a turn stops to ask for a credential. A service asking for any other scope fails the call, with no new sign-in.',
  ),
  'auth.clientId': field(
    'string',
    "Your OAuth client id, kept for the host's sign-in flow; the kernel doesn't read it.",
  ),
  'auth.redirectUri': field(
    'string',
    "Your OAuth redirect URI, kept for the host's sign-in flow; the kernel doesn't read it.",
  ),
  'playground.authType': field(
    unionType(PLAYGROUND_AUTH_TYPES),
    'The kind of credential the tool expects, or none.',
    PLAYGROUND_AUTH_TYPES,
    { none: 'The tool sends no credential.', ...CREDENTIAL_KINDS },
  ),
  'playground.testCredential': field(
    'string',
    "A credential for this tool's connection tests, kept in the tab and never saved.",
  ),
  'playground.stubOutput': {
    ...field(
      'Record<string, unknown>',
      'The playground has no code to run, so a function tool returns this, unless the playground has a demo handler by that name.',
    ),
    unset: 'A stand-in built from the output schema',
  },
  'playground.sampleInput': field(
    'Record<string, unknown>',
    'Arguments for the connection test, never saved.',
  ),
  'playground.inputSchema': field(
    'Record<string, unknown>',
    "The tool's arguments as a JSON Schema, sent to the model.",
  ),
  'playground.outputSchema': field(
    'Record<string, unknown>',
    "The tool's result as a JSON Schema, which a function tool's stand-in result is built from.",
  ),
  'registerStructured.jsonSchema': field(
    'Record<string, unknown>',
    'The JSON Schema a structured reply must follow, sent to the model as its response format.',
  ),
  access: field(
    unionType(TOOL_ACCESS),
    "What the tool can change, which taint.afterRemoteRead refuses calls by after a turn reads a remote tool's result.",
    TOOL_ACCESS,
    {
      'read-only': 'Only reads.',
      'read-write': 'Creates or updates things.',
      destructive: 'Deletes, charges, or does something else hard to undo.',
    },
  ),
  loadTier: field(
    unionType(TOOL_LOAD_TIERS),
    'When the tool becomes available to the model; live and host profiles load every allowed tool at the start.',
    TOOL_LOAD_TIERS,
    {
      T0: 'At the start of every turn.',
      T1: 'When tools.t1Policy picks it at the start of a turn.',
      T2: 'When the tools.t2Loader tool loads it mid-turn (custom tools only).',
    },
  ),
  permission: field(
    unionType(TOOL_PERMISSION),
    "Whether the host must approve a call before it runs; the provider's own tools never ask.",
    TOOL_PERMISSION,
    {
      auto: 'Runs without asking.',
      session_consent: 'Asks once; the approval lasts as long as the host keeps passing it back.',
      always_confirm: 'Asks every time.',
    },
  ),
  category: field('string', 'A label for grouping tools; nothing reads it yet.'),
  labels: field(
    'ToolLabels',
    'What the transcript says about a call. Each {path} is filled from the call; {results.0.name} steps into a list, and {path|text} shows the text when the value is missing, blank or not text or a number. Without a fallback, such a value drops the whole label.',
  ),
  'labels.activity': {
    ...field(
      'string',
      "What the transcript says while a call runs, e.g. 'Saving {title} to your collection'. Each {path} is filled from the call's input.",
    ),
    unset: 'The tool name, in words',
  },
  'labels.activityPast': {
    ...field(
      'string',
      "What the transcript says once a call completes, e.g. 'Found {results.0.name}'. Each {path} is filled from the call's input, then its output.",
    ),
    unset: 'The tool name, in words',
  },
  'labels.request': {
    ...field(
      'string',
      "What the approval card says the agent wants to do, e.g. 'check the weather in {city}'. Each {path} is filled from the call's input.",
    ),
    unset: 'The tool name, in words',
  },
  paths: {
    ...field(
      'string[]',
      'The turn paths this tool is offered on, where * means every path; a turn with no path gets only * tools. Host profiles ignore it.',
    ),
    unset: 'Every path',
  },
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
