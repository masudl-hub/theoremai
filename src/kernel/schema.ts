/**
 * Closed unions and the profile field catalog. No Deno APIs, so host UIs and docs can import it.
 *
 * @module
 */
/** labels-exempt-file: authoring field-meta / closed unions — not runtime user or model copy (P2) */
import { BOUNDARIES, BOUNDARY_META, recordOf } from '../guardrails/boundaries.ts';
import {
  DETECT_ACTION_META,
  DETECT_ACTIONS,
  DETECT_DEFAULTS,
  DETECTOR_BOUNDARIES,
  DETECTOR_META,
  DETECTORS,
  type Detector,
} from '../guardrails/detectors.ts';
import { LABEL_NOTES, type LabelKey } from '../guardrails/labels.ts';
import {
  BLOCKED_REPLY_ON_BLOCK,
  type BlockedReplyOnBlock,
  DESTINATION_GATES,
  TAINT_GATES,
} from '../guardrails/types.ts';
import { FIELD_DOCS, OPTION_DOCS } from './field-docs.ts';
import { PROFILE_FIELD_PRESENCE } from './profile-presence.ts';
import { isProfileRootField, profileFieldScope, profileKeysOf, valuesAt } from './profile-scope.ts';
import type { ToolBackground } from './tools/background.ts';
import type { DecisionQuestion } from './types.ts';

export { BLOCKED_REPLY_ON_BLOCK, type BlockedReplyOnBlock };
/** The kinds of profile: each fixes which fields and models a profile may use. */
export const PROFILE_TYPES = [
  /** A chat or task agent. Each turn the model answers in text, or in JSON when outputs ask for a structured reply, and can call tools on the way. */
  'text',
  /** Makes pictures from a prompt, in the shape, size, and format the image block sets. */
  'image',
  /** Gives your app a voice. Each turn reads text aloud in the voice the speech block names. */
  'speech',
  /** Turns a voice clip into text. Each turn takes one clip and gives back what was said. */
  'transcription',
  /** For talking in real time. One continuous voice and video session, rather than separate turns. */
  'live',
  /** For when your app needs a judgement, not a reply. It answers questions about a JSON state, each with a choice, a score, or a number. */
  'decision',
  /** For when your app needs vectors from text or provider-supported media. */
  'embedding',
  /** A governed passthrough to your tool registry, with no model. It calls MCP, HTTP, and in-app function tools under the same permissions and traces as any agent, guarded by detect and network. */
  'host',
] as const;
/** One of {@linkcode PROFILE_TYPES}. */
export type ProfileType = (typeof PROFILE_TYPES)[number];
/** Reasoning effort levels, lowest to highest; a model accepts only the levels its catalog row lists. */
export const THINKING_LEVELS = [
  /** No thinking, where the provider has that level. */
  'none',
  /** The least thinking. */
  'minimal',
  /** Light thinking. */
  'low',
  /** Moderate thinking. */
  'medium',
  /** Heavy thinking. */
  'high',
  /** Heavier thinking, where the provider has that level. */
  'xhigh',
  /** The most thinking the model supports, where the provider has that level. */
  'max',
] as const;
/** One of {@linkcode THINKING_LEVELS}. */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
/** The longest a profile's `id` may be, in characters: room for a dotted or generated one. */
export const PROFILE_ID_MAX_CHARS = 64;
/** The longest a profile's `identity.handle` may be, in characters: it is a name people read. */
export const PROFILE_HANDLE_MAX_CHARS = 32;
/** A vault slot's name, chosen by the host. The profile names slots; the host fills them with keys. */
export type KeySlot = string;
/** Letters, digits, `-`, and `_`, up to 32 characters, starting with a letter or digit. */
export const KEY_SLOT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
/** True when the value is a legal key slot name. */
export function isKeySlotName(value: unknown): value is KeySlot {
  return typeof value === 'string' && KEY_SLOT_NAME.test(value);
}
/** The host-filled keys by slot name; a slot with no key is `undefined`. */
export type { KeyVault } from './registry/vault.ts';
/** The kinds of media a model can take as input. */
export const MEDIA_INPUT_KIND_VALUES = ['image', 'audio', 'video', 'document'] as const;
/** One of {@linkcode MEDIA_INPUT_KIND_VALUES}. */
export type MediaInputKind = (typeof MEDIA_INPUT_KIND_VALUES)[number];
/** Whether thought summaries are asked for (`auto`) or not (`none`). */
export const SUMMARY_MODES = ['auto', 'none'] as const;
/** One of {@linkcode SUMMARY_MODES}. */
export type SummaryMode = (typeof SUMMARY_MODES)[number];
/** Whether the provider call streams (`sse`) or is one buffered call. */
export const STREAM_MODES = [
  /** Events arrive as the model writes, so a reply that fails outputs.validation has already streamed when it is rewritten; some providers always answer image and speech in one piece. */
  'sse',
  /** One non-streaming call, whose events arrive together; under outputs.validation, only once the reply passes or retries run out. Thinking still streams. */
  'buffered',
] as const;
/** One of {@linkcode STREAM_MODES}. */
export type StreamMode = (typeof STREAM_MODES)[number];
/** Audio encodings a speech profile can return. */
export const SPEECH_AUDIO_FORMATS = [
  /** Uncompressed audio, delivered as WAV. */
  'pcm',
  /** Compressed audio; a provider that cannot make it refuses the turn. */
  'mp3',
] as const;
/** One of {@linkcode SPEECH_AUDIO_FORMATS}. */
export type SpeechAudioFormat = (typeof SPEECH_AUDIO_FORMATS)[number];
/** Who can send a turn its context: the browser, or the host's own code. */
/** How long a caller is away, in milliseconds, before `live.resumed.prompt` is sent, when the profile sets no `afterMs`. */
export const DEFAULT_RESUMED_AFTER_MS = 3000;
export const CONTEXT_SENDERS = [
  /** The browser. A visitor can change it, so it is untrusted. */
  'client',
  /** The host's own code. It is assembled, like turn system text. */
  'server',
] as const;
/** One of {@linkcode CONTEXT_SENDERS}. */
export type ContextSender = (typeof CONTEXT_SENDERS)[number];
/** What the user starting to speak does to a live model that is mid-reply. */
export const LIVE_ACTIVITY_HANDLINGS = [
  /** The user speaking cuts the reply off. */
  'START_OF_ACTIVITY_INTERRUPTS',
  /** The model finishes its reply. */
  'NO_INTERRUPTION',
] as const;
/** One of {@linkcode LIVE_ACTIVITY_HANDLINGS}. */
export type LiveActivityHandling = (typeof LIVE_ACTIVITY_HANDLINGS)[number];
/** How readily live voice detection decides the user has started speaking. */
export const LIVE_START_SENSITIVITIES = [
  /** Detects the start of speech less often. */
  'START_SENSITIVITY_LOW',
  /** Detects the start of speech more often. */
  'START_SENSITIVITY_HIGH',
] as const;
/** One of {@linkcode LIVE_START_SENSITIVITIES}. */
export type LiveStartSensitivity = (typeof LIVE_START_SENSITIVITIES)[number];
/** How readily live voice detection decides the user has stopped speaking. */
export const LIVE_END_SENSITIVITIES = [
  /** Ends speech less often, waiting through pauses. */
  'END_SENSITIVITY_LOW',
  /** Ends speech more often, at shorter pauses. */
  'END_SENSITIVITY_HIGH',
] as const;
/** One of {@linkcode LIVE_END_SENSITIVITIES}. */
export type LiveEndSensitivity = (typeof LIVE_END_SENSITIVITIES)[number];
/** What compaction counts against its token limit: the stored history or the next request's input. */
export const COMPACTION_METERS = [
  /** Tokens in the earlier conversation. */
  'history',
  /** The prompt tokens the provider reported for the last call, or the count the host passes in. */
  'input',
] as const;
/** One of {@linkcode COMPACTION_METERS}. */
export type CompactionMeter = (typeof COMPACTION_METERS)[number];
/** Whether compaction runs before or after a turn. */
export const COMPACTION_TIMINGS = [
  /** The kernel compacts before the turn runs. */
  'before',
  /** The turn's done event says compaction is due, and the host runs it. */
  'after',
] as const;
/** One of {@linkcode COMPACTION_TIMINGS}. */
export type CompactionTiming = (typeof COMPACTION_TIMINGS)[number];
/** What a compaction did. */
export const COMPACTION_OUTCOMES = [
  /** A summary replaced the compacted messages. */
  'compacted',
  /** The compactor failed and the history still fits `maxTokens`, so it is kept whole. */
  'deferred',
  /** The compactor failed over `maxTokens`, so the compacted messages were dropped. */
  'dropped',
] as const;
/** One of {@linkcode COMPACTION_OUTCOMES}. */
export type CompactionOutcome = (typeof COMPACTION_OUTCOMES)[number];
/** Why a turn stopped, as `done.stop.kind` reports it. */
export const TURN_STOP_KINDS = [
  /** The model finished its reply. */
  'completed',
  /** The model reached its token limit. */
  'length',
  /**
   * The model called tools and the turn hands them to the host, in done.tools.
   *
   * @remarks The model called tools and the turn hands them to the host (`done.tools`).
   */
  'tool',
  /**
   * A tool call waits for confirmation, permission, sign-in, or the page that answers it. The host
   * resumes it with invokeTool, not continueFrom.
   *
   * @remarks `pre_tool` blocked the body; the host resumes via invokeTool/executeTool, not continueFrom.
   */
  'gate',
  /** The provider filtered the reply, or the egress guardrail withheld it. */
  'filtered',
  /** The provider failed or reported an error. */
  'provider_error',
  /** The user or host cancelled the turn, or a stage aborted it. */
  'cancelled',
  /** The stream ended without the provider reporting a final status. */
  'stream_incomplete',
  /**
   * The last model call maxSteps allows asked for tools, so the turn ended with no answer.
   *
   * @remarks The turn made its last allowed model call and that call asked for tools: there is no answer.
   */
  'step_limit',
  /** The model finished without calling the answer tool, and no repair was left. */
  'answer_missing',
  /** Live: the user spoke over the reply and cut it off. */
  'interrupted',
  /**
   * Live: the model finished generating audio or text for this utterance. The turn may still be open.
   *
   * @remarks Live: model finished generating audio/text for this utterance; turn may still be open.
   */
  'generation_complete',
] as const;
/** One of {@linkcode TURN_STOP_KINDS}. */
export type TurnStopKind = (typeof TURN_STOP_KINDS)[number];
/** What a text turn's last allowed model call may do, as `turnBehaviour.atStepLimit` sets it. */
export const STEP_LIMIT_MODES = [
  /** It may still call tools; if it does, they run and the turn stops as step_limit with no answer. */
  'stop',
  /** It is sent without tools, so it writes the answer from what the turn has gathered. */
  'answer',
] as const;
/** What happens to a list item its check refuses, as `outputs.validation.items.*.onFail` sets it. */
export const ITEM_FAIL_ACTIONS = ['drop', 'fix'] as const;
/** One of {@linkcode STEP_LIMIT_MODES}. */
export type StepLimitMode = (typeof STEP_LIMIT_MODES)[number];
/** Every other stop resumes by another host path, or not at all. */
export const CONTINUE_STOP_KINDS = [
  /** The reply hit the output token limit. */
  'length',
  /** The connection dropped mid-reply. */
  'stream_incomplete',
  /** The provider returned an error or timed out. */
  'provider_error',
  /** The model finished without calling the answer tool. */
  'answer_missing',
] as const;
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
/** `pre_tool` gates; not `awaiting_user_input`. `page` holds a call for the page that answers it. */
export const TOOL_GATE_KINDS = ['confirmation', 'permission', 'auth', 'page'] as const;
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
  'inject_released_invalid',
  'deny_invalid',
  'confirm_invalid',
  'mutate_invalid',
  'label_failed_invalid',
  'abort_invalid',
  'wait_for_invalid',
  'end_not_allowed',
  'end_invalid',
  'unknown_field',
  'result_invalid',
] as const;
/** One of {@linkcode STAGE_APPLY_WARNING_CODES}. */
export type StageApplyWarningCode = (typeof STAGE_APPLY_WARNING_CODES)[number];
/** The `status` of a tool output that asks the user a question. */
export const AWAITING_USER_INPUT_STATUS = 'awaiting_user_input' as const;
/** Enforced by the kernel at resolve time. */
export const TOOL_LOAD_TIERS = [
  /** At the start of every turn. */
  'T0',
  /** On demand: when tools.t1Policy picks it at the start of a turn, or when the tools.t2Loader tool loads it mid-turn (custom tools only). */
  'T2',
] as const;
/** One of {@linkcode TOOL_LOAD_TIERS}. */
export type ToolLoadTier = (typeof TOOL_LOAD_TIERS)[number];
/** The HTTP methods an `http` tool may use. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
/** One of {@linkcode HTTP_METHODS}. */
export type HttpMethod = (typeof HTTP_METHODS)[number];
/** When remote tool auth is missing or expired. */
export const AUTH_UNAUTHENTICATED_POLICIES = [
  /** The turn stops and asks the host for a credential. */
  'gate',
  /** The model is told the tool isn't signed in, and the turn goes on. */
  'report_to_model',
  /** The call fails as not signed in, for a key the host holds that no person can sign in to replace. */
  'fail',
] as const;
/** One of {@linkcode AUTH_UNAUTHENTICATED_POLICIES}. */
export type AuthUnauthenticatedPolicy = (typeof AUTH_UNAUTHENTICATED_POLICIES)[number];
/** The kinds of tool a profile can list. */
export const TOOL_TYPES = [
  /** The provider's own tool, such as its web search, run by the provider. */
  'builtin',
  /** Your handler runs it. */
  'function',
  /** The kernel calls your HTTP endpoint. */
  'http',
  /** The kernel calls a tool on a remote MCP server. */
  'mcp',
  /** The kernel runs one turn of another registered agent and returns its reply. */
  'agent',
] as const;
/** When the model gets a tool's reply, as `registerTool.background` sets it. */
const TOOL_BACKGROUND_MODES = [
  /** The model gets its reply when the body ends. */
  'never',
  /** The model chooses, call by call, whether to go on without the result. */
  'ask',
  /** The model gets its reply at once, and the body goes on after the turn. */
  'always',
  /** The model gets its reply once the body has run past this time. */
  'afterMs',
] as const satisfies readonly (
  | Extract<ToolBackground, string>
  | keyof Extract<ToolBackground, object>
)[];
/** The kinds of question a decision asks, as `decision.questions.type` sets them. */
const DECISION_QUESTION_TYPES = [
  /** One of the named options, with a confidence and a probability for each option. */
  'choice',
  /** A level on an ordered scale, with a confidence. */
  'score',
  /** One number, which may weigh named criteria. */
  'noul',
  /** Where something is in an image: its top, bottom, left and right edges, with a confidence. */
  'box',
] as const satisfies readonly DecisionQuestion['type'][];
/** How much a tool can change: nothing, data, or irreversibly. */
export const TOOL_ACCESS = [
  /** Only reads. */
  'read-only',
  /** Creates or updates things. */
  'read-write',
  /** Deletes, charges, or does something else hard to undo. */
  'destructive',
] as const;
/** One of {@linkcode TOOL_ACCESS}. */
export type ToolAccess = (typeof TOOL_ACCESS)[number];
/** When the user must approve a tool call: never, once per session, or every call. */
export const TOOL_PERMISSION = [
  /** Runs without asking. */
  'auto',
  /** Asks once; the approval lasts as long as the host keeps passing it back. */
  'session_consent',
  /** Asks every time. */
  'always_confirm',
] as const;
/** One of {@linkcode TOOL_PERMISSION}. */
export type ToolPermission = (typeof TOOL_PERMISSION)[number];
/** The credential shapes a remote tool can authenticate with. */
export const TOOL_AUTH_TYPES = [
  /** A token; a secret typed in at the prompt becomes a bearer token. */
  'bearer',
  /** An API key; a secret typed in at the prompt becomes an API key. */
  'api_key',
  /** An OAuth sign-in; the host supplies the token. */
  'oauth2',
] as const;
/** One of {@linkcode TOOL_AUTH_TYPES}. */
export type ToolAuthType = (typeof TOOL_AUTH_TYPES)[number];
/** Adds UI-only `none`, which omits auth at compile time. */
export const STUDIO_AUTH_TYPES = [
  /** The tool sends no credential. */
  'none',
  ...TOOL_AUTH_TYPES,
] as const;
/** One of {@linkcode STUDIO_AUTH_TYPES}. */
export type StudioAuthType = (typeof STUDIO_AUTH_TYPES)[number];
/** One of {@linkcode TOOL_TYPES}. */
export type ToolType = (typeof TOOL_TYPES)[number];
/** A tool type the host defines, which is every type but `builtin`. */
export type CustomToolType = Exclude<ToolType, 'builtin'>;
/**
 * The package's complete media-input vocabulary: `assertMediaMime` refuses any MIME not
 * here, so hosts keep no second table. Rows follow the widest provider's documented
 * lists (verified 2026-09-12), plus TypeScript, `application/xml` and `application/rtf`. Provider alias essences (`image/jpg`, `video/mov`, …) are rows;
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
function unionType(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(' | ');
}
/** What the catalog records about one profile field: its type, description, options, and when it applies. */
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
/** A field a kernel type declares: its doc is the JSDoc there, through `FIELD_DOCS`. */
function field(
  type: string,
  options?: readonly string[],
  optionDescriptionsOrNote?: Record<string, string> | string,
  optionNote?: string,
): FieldMeta {
  return metaField(type, '', options, optionDescriptionsOrNote, optionNote);
}
/**
 * A detector or boundary row: its doc is `DETECTOR_META`'s or `BOUNDARY_META`'s, since a member
 * of a string union has no JSDoc.
 */
function metaField(
  type: string,
  doc: string,
  options?: readonly string[],
  optionDescriptionsOrNote?: Record<string, string> | string,
  optionNote?: string,
): FieldMeta {
  if (options) {
    if (typeof optionDescriptionsOrNote === 'object') {
      sourcedOptionDocs(options, optionDescriptionsOrNote);
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
 * Throws unless the docs are a list's `OPTION_DOCS` entry, or `DETECT_ACTION_META`'s, and name
 * exactly these options, so a value's doc has one source.
 */
function sourcedOptionDocs(options: readonly string[], docs: Record<string, string>): void {
  const sourced =
    Object.values(OPTION_DOCS).includes(docs) ||
    DETECT_ACTIONS.every((action) => docs[action] === DETECT_ACTION_META[action].doc);
  if (!sourced) throw new Error(`option docs for ${options.join(', ')} are not a list's JSDoc`);
}
/**
 * Parents whose next key is a host-owned map key (model id, slot name, …).
 * The annotator substitutes `*` so `models.flash.apiId` → `models.*.apiId`.
 */
export const DYNAMIC_FIELD_PARENTS: ReadonlySet<string> = new Set([
  'models',
  'models.*.efforts',
  'labels',
  'inputs.options',
  'identity.options',
  'inputs.limitsByMime',
  'outputs.validation.fields',
  'outputs.validation.items',
]);
/** Turns a key path into its catalog path, replacing host-chosen map keys with `*`. */
export function catalogPathFor(keys: readonly string[]): string {
  const [first] = keys;
  if (keys.length === 1 && first !== undefined && isProfileRootField(first))
    return `profile.${first}`;
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
const DETECT_ACTION_DOCS = recordOf(DETECT_ACTIONS, (action) => DETECT_ACTION_META[action].doc);
/** The `allow` rows of a detector: the URLs it lets through, or for `tool_leak` the names. */
function allowFields(path: string, detector: Detector): [string, FieldMeta][] {
  if (DETECTOR_META[detector].allow === 'names') {
    return [
      [`${path}.allow`, field('NameAllow')],
      [
        `${path}.allow.names`,
        {
          ...field('string[]'),
          unset: 'None',
        },
      ],
    ];
  }
  return [
    [`${path}.allow`, field('UrlAllow')],
    [`${path}.allow.hosts`, { ...field('string[]'), unset: 'None' }],
    [
      `${path}.allow.fromTools`,
      {
        ...field('boolean'),
        unset: 'On',
      },
    ],
  ];
}
/** The rows of one pattern in a detector's `patterns`. */
function patternRows(path: string): [string, FieldMeta][] {
  const each = `${path}.patterns.*`;
  return [
    [`${each}.name`, field('string')],
    [`${each}.pattern`, field('string')],
    [
      `${each}.flags`,
      {
        ...field('string'),
        unset: 'None',
      },
    ],
    [`${each}.words`, field('string[]')],
  ];
}
/** The rows of a detector of the host's own, under a key with a dot. */
function hostDetectorFields(path: string): [string, FieldMeta][] {
  const action = (doc?: string) =>
    doc
      ? metaField('DetectAction', doc, DETECT_ACTIONS, DETECT_ACTION_DOCS)
      : field('DetectAction', DETECT_ACTIONS, DETECT_ACTION_DOCS);
  return [
    [path, field('HostDetectorConfig')],
    [`${path}.label`, field('string')],
    [
      `${path}.action`,
      {
        ...action(),
        unset: 'Only the boundaries at names are read',
      },
    ],
    [`${path}.at`, field('{ [boundary]: DetectAction }')],
    ...BOUNDARIES.map((boundary): [string, FieldMeta] => [
      `${path}.at.${boundary}`,
      { ...action(BOUNDARY_META[boundary].doc), unset: DETECT_ACTION_META.ignore.label },
    ]),
    ...patternTail(path, 'The labels’s detect.hint.own, which names the label'),
    [`${path}.find`, field('HostFind')],
  ];
}
/** The rows of a detector that reads with patterns: whose it reads with. */
function patternFields(path: string): [string, FieldMeta][] {
  return [
    [
      `${path}.theorem`,
      {
        ...field('boolean'),
        unset: 'On',
      },
    ],
    ...patternTail(path, 'The labels’s detect.hint line for this detector'),
  ];
}

/** The patterns, compiled patterns and hint rows a detector that reads with patterns shares. */
function patternTail(path: string, hintUnset: string): [string, FieldMeta][] {
  return [
    [`${path}.patterns`, { ...field('HostPattern[]'), unset: 'None' }],
    ...patternRows(path),
    [`${path}.compiled`, field('CompiledPatterns')],
    [`${path}.hint`, { ...field('string'), unset: hintUnset }],
  ];
}
/** The settings a detector's full form takes, as a sentence lists them. */
function settingsOf(detector: Detector): string {
  const { allow, patterns } = DETECTOR_META[detector];
  if (allow && patterns) return 'action, at, allow, theorem, patterns, and hint';
  if (allow) return 'action, at, and allow';
  return patterns ? 'action, at, theorem, patterns, and hint' : 'action and at';
}
/** The `guardrails.detect` rows: one for the setting, one per detector, and one per detector and boundary. */
function detectFields(): Record<string, FieldMeta> {
  const action = (type: string, doc?: string) =>
    doc
      ? metaField(type, doc, DETECT_ACTIONS, DETECT_ACTION_DOCS)
      : field(type, DETECT_ACTIONS, DETECT_ACTION_DOCS);
  const rows: [string, FieldMeta][] = [
    ['guardrails.detect', action('DetectAction | { [detector]: DetectorRule }')],
  ];
  for (const detector of DETECTORS) {
    const path = `guardrails.detect.${detector}`;
    rows.push([
      path,
      action(
        'DetectAction | DetectorConfig',
        `${DETECTOR_META[detector].doc} Set one action, or ${settingsOf(detector)}.`,
      ),
    ]);
    if (DETECTOR_META[detector].allow) rows.push(...allowFields(path, detector));
    if (DETECTOR_META[detector].patterns) rows.push(...patternFields(path));
    rows.push([
      `${path}.action`,
      {
        ...action('DetectAction'),
        unset: 'Each boundary keeps its default',
      },
    ]);
    rows.push([`${path}.at`, field('{ [boundary]: DetectAction }')]);
    for (const boundary of DETECTOR_BOUNDARIES[detector]) {
      const unset = DETECT_ACTION_META[DETECT_DEFAULTS[detector][boundary]].label;
      const meta = action('DetectAction', BOUNDARY_META[boundary].doc);
      rows.push([`${path}.at.${boundary}`, { ...meta, unset }]);
    }
  }
  rows.push(...hostDetectorFields('guardrails.detect.*'));
  return Object.fromEntries(rows);
}
/** Gives each field its doc from `FIELD_DOCS`; a field that also writes one here throws, so one text has one source. */
function withFieldDocs(fields: Record<string, FieldMeta>): Record<string, FieldMeta> {
  return Object.fromEntries(
    Object.entries(fields).map(([path, meta]) => {
      const declared = FIELD_DOCS[path];
      if (declared === undefined) return [path, meta];
      if (meta.doc) {
        throw new Error(
          `${path}: a kernel type declares it, so its doc is that JSDoc; use field()`,
        );
      }
      return [path, { ...meta, doc: declared }];
    }),
  );
}
function withScopeAndPresence(fields: Record<string, FieldMeta>): Record<string, FieldMeta> {
  return Object.fromEntries(
    Object.entries(withFieldDocs(fields)).map(([path, meta]) => {
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
 * Adding a profile field? Write its doc as JSDoc on the type, run `deno task field-docs`, and add
 * it here with `field()`; scope it in `PROFILE_FIELD_SCOPE` if only some types take it, and record
 * it in `PROFILE_FIELD_PRESENCE` if it is required or its absence matters. A map's entries
 * (`models.*`) take their doc from a `@catalog <path> <text>` tag on the map's property.
 */
export const PROFILE_FIELDS: Record<string, FieldMeta> = withScopeAndPresence({
  'profile.id': field('string'),
  'profile.type': field(
    "'text' | 'image' | 'speech' | 'transcription' | 'live' | 'decision' | 'embedding' | 'host'",
    PROFILE_TYPES,
    OPTION_DOCS.PROFILE_TYPES,
  ),
  identity: field('{ handle, options?, system? }'),
  'identity.handle': field('string'),
  'identity.options': field('Record<string, OptionDecl>'),
  'identity.options.*': field('OptionDecl'),
  'identity.options.*.label': field('string'),
  'identity.options.*.choices': field('OptionChoice[]'),
  'identity.options.*.choices.*.value': field('string'),
  'identity.options.*.choices.*.description': field('string'),
  'identity.system': field('string | Array<string | Array<string | { private: string }>>'),
  models: field('Record<ModelId, ModelBinding | DecisionModelBinding>'),
  'models.*': field('ModelBinding | DecisionModelBinding'),
  'models.*.protocol': field('string'),
  'models.*.provider': field('string'),
  'models.*.keySlot': field('KeySlot'),
  'models.*.fallbackKeySlot': field('KeySlot'),
  'models.*.options': field('JsonObject'),
  providerContinuation: field('ProviderContinuationPolicy'),
  'providerContinuation.history': field("'host' | 'stateless' | 'provider'", [
    'host',
    'stateless',
    'provider',
  ]),
  'models.*.apiId': field('string'),
  'models.*.timeoutMs': field('number'),
  'models.*.limits': field('ProviderLimits'),
  'models.*.limits.operationTimeoutMs': field('number'),
  'models.*.limits.connectTimeoutMs': field('number'),
  'models.*.limits.liveStepTimeoutMs': field('number'),
  'models.*.limits.maxWireRecordBytes': field('number'),
  'models.*.limits.maxWireResponseBytes': field('number'),
  'models.*.limits.maxEventBytes': field('number'),
  'models.*.limits.maxStepBytes': field('number'),
  'models.*.limits.maxStepEvents': field('number'),
  'models.*.limits.maxPendingToolCalls': field('number'),
  decision: field('{ contract: DecisionContractId }'),
  'decision.contract': field('string'),
  'models.*.efforts': field('Record<string, ThinkingLevel>'),
  'models.*.efforts.*': field(
    unionType(THINKING_LEVELS),
    THINKING_LEVELS,
    OPTION_DOCS.THINKING_LEVELS,
  ),
  'models.*.defaultEffort': field('string'),
  'models.*.allowEffortSelect': field('boolean'),
  'models.*.summaries': field('boolean'),
  'models.*.maxOutputTokens': field('number'),
  'models.*.temperature': field('number'),
  'models.*.builtInTools': field('BuiltinToolId[]'),
  'models.*.compaction': field('CompactionSpec'),
  'models.*.compaction.maxTokens': field('number'),
  'models.*.compaction.trigger': field(
    '(ctx: CompactionTriggerContext) => boolean | Promise<boolean>',
  ),
  'models.*.compaction.compactAt': field('number'),
  'models.*.compaction.previousExchanges': field('number'),
  'models.*.compaction.profile': {
    ...field('ProfileId'),
    unset: 'The agent itself',
  },
  'models.*.compaction.timing': field(
    unionType(COMPACTION_TIMINGS),
    COMPACTION_TIMINGS,
    OPTION_DOCS.COMPACTION_TIMINGS,
  ),
  'models.*.compaction.meter': field(
    unionType(COMPACTION_METERS),
    COMPACTION_METERS,
    OPTION_DOCS.COMPACTION_METERS,
  ),
  'profile.defaultModel': field('ModelId'),
  'profile.allowModelSelect': field('boolean'),
  'profile.maxSteps': field('number'),
  tools: field('{ allow: ToolId[]; t1Policy?; t2Loader?; parallel? }'),
  'tools.allow': field('ToolId[]'),
  'tools.t1Policy': field('(ctx) => ToolId[] | Promise<ToolId[]>'),
  'tools.t2Loader': field('ToolId'),
  'tools.parallel': field('boolean'),
  inputs: field('ProfileInputsSpec | DecisionInputsSpec'),
  'inputs.state': field("'json'", ['json']),
  'inputs.maxStateBytes': field('number'),
  'inputs.text': field('boolean'),
  'inputs.attachments': field('{ accept: string[] }'),
  'inputs.attachments.accept': field(
    'string[]',
    ATTACHMENT_ACCEPT_MIMES,
    "Types the kernel knows; a listed type it doesn't know is refused when a turn sends it.",
  ),
  'inputs.voice': field('{ accept: string[] }'),
  'inputs.voice.accept': field('string[]', VOICE_ACCEPT_MIMES, 'Audio types the kernel knows.'),
  'inputs.maxFiles': field('number'),
  'inputs.maxBytes': field('number'),
  'inputs.maxTurnBytes': field('number'),
  'inputs.limitsByMime': field('Record<string, number>'),
  'inputs.limitsByMime.*': field('number'),
  'inputs.options': field('Record<string, OptionDecl>'),
  'inputs.options.*': field('OptionDecl'),
  'inputs.options.*.label': field('string'),
  'inputs.options.*.choices': field('OptionChoice[]'),
  'inputs.options.*.choices.*.value': field('string'),
  'inputs.options.*.choices.*.description': field('string'),
  'inputs.context': field('{ from: ContextSender[]; maxChars: number }'),
  'inputs.context.from': field(
    "Array<'client' | 'server'>",
    CONTEXT_SENDERS,
    OPTION_DOCS.CONTEXT_SENDERS,
  ),
  'inputs.context.maxChars': field('number'),
  outputs: field('ProfileOutputsSpec'),
  'outputs.structured': field('StructuredSchemaId | StructuredByOption | null'),
  image: field('ProfileImageSpec'),
  'image.aspectRatio': field('string'),
  'image.resolution': field('string'),
  'image.mimeType': field('string'),
  'image.quality': field('string'),
  'image.background': field('string'),
  'image.n': field('number'),
  'image.seed': field('number'),
  'image.outputCompression': field('number'),
  'image.references': field('Array<TurnBlob | TurnMediaRef>'),
  'image.includeText': field('boolean'),
  speech: field('ProfileSpeechSpec'),
  'speech.voice': field('string'),
  'speech.style': field('string'),
  'speech.speed': field('number'),
  'speech.format': field(
    unionType(SPEECH_AUDIO_FORMATS),
    SPEECH_AUDIO_FORMATS,
    OPTION_DOCS.SPEECH_AUDIO_FORMATS,
  ),
  live: field('ProfileLiveSpec'),
  'live.ingress': field('LiveIngressSpec'),
  'live.ingress.audio': field('boolean'),
  'live.ingress.video': field('boolean'),
  'live.ingress.text': field('boolean'),
  'live.voice': field('string'),
  'live.vad': field('LiveVadSpec'),
  'live.vad.activityHandling': field(
    unionType(LIVE_ACTIVITY_HANDLINGS),
    LIVE_ACTIVITY_HANDLINGS,
    OPTION_DOCS.LIVE_ACTIVITY_HANDLINGS,
  ),
  'live.vad.startSensitivity': field(
    unionType(LIVE_START_SENSITIVITIES),
    LIVE_START_SENSITIVITIES,
    OPTION_DOCS.LIVE_START_SENSITIVITIES,
  ),
  'live.vad.endSensitivity': field(
    unionType(LIVE_END_SENSITIVITIES),
    LIVE_END_SENSITIVITIES,
    OPTION_DOCS.LIVE_END_SENSITIVITIES,
  ),
  'live.vad.prefixPaddingMs': field('number'),
  'live.vad.silenceDurationMs': field('number'),
  'live.sessionResumption': field('boolean'),
  'live.greeting': field('string'),
  'live.resumed': field('{ prompt: string; afterMs?: number }'),
  'live.resumed.prompt': field('string'),
  'live.resumed.afterMs': field('number'),
  'live.contextCompression': field('LiveContextCompressionSpec'),
  'live.contextCompression.triggerTokens': field('number'),
  'live.contextCompression.slidingWindow': field('LiveSlidingWindowSpec'),
  'live.contextCompression.slidingWindow.targetTokens': field('number'),
  'live.transcription': field('LiveTranscriptionSpec'),
  'live.transcription.input': field('boolean'),
  'live.transcription.output': field('boolean'),
  'outputs.validation': field('ProfileValidationSpec'),
  'outputs.validation.fields': field('Record<string, ProfileValidator>'),
  'outputs.validation.fields.*': field(
    '(candidate: unknown, options?: Record<string, string>) => ValidationResult | Promise<ValidationResult>',
  ),
  'outputs.validation.items': field('Record<string, ProfileItemRule>'),
  'outputs.validation.items.*': field('ProfileItemRule'),
  'outputs.validation.items.*.check': field(
    '(item: unknown, turn: ItemCheckTurn) => ValidationResult | Promise<ValidationResult>',
  ),
  'outputs.validation.items.*.onFail': field("'drop' | 'fix'", ITEM_FAIL_ACTIONS),
  'outputs.validation.maxRetries': field('number'),
  'outputs.streaming': field('ProfileStreamingSpec'),
  'outputs.streaming.mode': field(unionType(STREAM_MODES), STREAM_MODES, OPTION_DOCS.STREAM_MODES),
  'outputs.streaming.streamThoughts': field('boolean'),
  turnBehaviour: field('ProfileTurnBehaviourSpec'),
  'turnBehaviour.resumption': field('ProfileTurnResumptionSpec'),
  'turnBehaviour.resumption.allowContinue': field(
    'ContinueStopKind[]',
    CONTINUE_STOP_KINDS,
    OPTION_DOCS.CONTINUE_STOP_KINDS,
  ),
  'turnBehaviour.resumption.autoContinue': field(
    'ContinueStopKind[]',
    CONTINUE_STOP_KINDS,
    OPTION_DOCS.CONTINUE_STOP_KINDS,
  ),
  'turnBehaviour.resumption.maxContinues': field('number'),
  'turnBehaviour.allowSteering': field('boolean'),
  'turnBehaviour.atStepLimit': field(
    "'stop' | 'answer'",
    STEP_LIMIT_MODES,
    OPTION_DOCS.STEP_LIMIT_MODES,
  ),
  guardrails: field('ProfileGuardrailsSpec'),
  'guardrails.quota': field('QuotaGuardrailSpec'),
  'guardrails.quota.perDay': field('number'),
  ...detectFields(),
  'guardrails.blockedReply': field('BlockedReplySpec'),
  'guardrails.blockedReply.onBlock': field(
    unionType(BLOCKED_REPLY_ON_BLOCK),
    BLOCKED_REPLY_ON_BLOCK,
    OPTION_DOCS.BLOCKED_REPLY_ON_BLOCK,
  ),
  'guardrails.blockedReply.maxRetries': field('number'),
  'guardrails.network': field('NetworkGuardrailSpec'),
  'guardrails.network.allowPrivateNetworks': field('boolean'),
  'guardrails.network.allowedHosts': field('string[]'),
  'guardrails.network.allowedSchemes': field('string[]'),
  'guardrails.taint': field('TaintGuardrailSpec'),
  'guardrails.taint.afterRemoteRead': field(
    unionType(TAINT_GATES),
    TAINT_GATES,
    OPTION_DOCS.TAINT_GATES,
  ),
  'guardrails.taint.remoteDestination': field(
    unionType(DESTINATION_GATES),
    DESTINATION_GATES,
    OPTION_DOCS.DESTINATION_GATES,
  ),
  'guardrails.disclosure': field('{ enforce: DecisionDisclosureEnforcer }'),
  'guardrails.disclosure.enforce': field(
    '(state, context) => DecisionDisclosureVerdict | Promise<DecisionDisclosureVerdict>',
  ),
  labels: field('LabelOverrides'),
  'labels.*': field('string'),
  observability: field('ProfileObservabilitySpec'),
  'observability.writeTo': field('false | string | TraceSink'),
  'observability.sampleRate': field('number'),
  'observability.include': field('TraceIncludeSpec'),
  'observability.include.upstreamLog': field('boolean'),
  'observability.include.outboundWire': field('boolean'),
  'observability.include.evidenceRaw': field('boolean'),
  'observability.include.usage': field('boolean'),
  'observability.include.guardrailDecisions': field('boolean'),
  'observability.include.guardrailMatchPreview': field('boolean'),
  'observability.resource': field('Record<string, TraceAttributeValue>'),
  'observability.scrub': field('TraceScrubSpec'),
  'observability.scrub.sensitive': field('ScrubSwitch'),
  'observability.scrub.injection': field('ScrubSwitch'),
  'observability.scrub.canary': field('ScrubSwitch'),
  'observability.retainForDays': field('number'),
  'observability.rotateAfterMiB': field('number'),
  'observability.onWriteError': field('(err: unknown) => void'),
});
const TOOL_TYPE_FIELD = field(unionType(TOOL_TYPES), TOOL_TYPES, OPTION_DOCS.TOOL_TYPES);
/**
 * The catalog of the fields `registerTool` takes, keyed `registerTool.<field>`. The `studio.` and
 * `local.` rows are the studio's own; a builder never sets them.
 */
export const EXTRA_FIELDS: Record<string, FieldMeta> = withFieldDocs({
  'done.stop.kind': field('TurnStopKind', TURN_STOP_KINDS, OPTION_DOCS.TURN_STOP_KINDS),
  'registerTool.type': TOOL_TYPE_FIELD,
  /** Studio-only rows: the editor's local-model connection, and a decision's questions and images. */
  'local.baseUrl': field('string'),
  'studio.remoteTools': {
    ...field('boolean'),
    unset: 'Off',
  },
  'decision.questions.id': field('string'),
  'decision.questions.type': field(
    unionType(DECISION_QUESTION_TYPES),
    DECISION_QUESTION_TYPES,
    OPTION_DOCS.DECISION_QUESTION_TYPES,
  ),
  'decision.questions.instructions': field('DecisionEntry'),
  'decision.questions.image': {
    ...field('string'),
    unset: 'The image the instructions name',
  },
  'decision.images': field('Record<string, DecisionAsset>'),
  'decision.images.name': field('string'),
  'registerTool.name': field('string'),
  'registerTool.description': field('string'),
  'registerTool.input': field('ZodSchema'),
  'registerTool.output': field('ZodSchema'),
  'registerTool.handler': field('ToolHandler'),
  'registerTool.endpoint': field('string'),
  'registerTool.method': field(unionType(HTTP_METHODS), HTTP_METHODS),
  'registerTool.headers': field('Record<string, string>'),
  'registerTool.mapping': field('{ pathParams?, queryParams?, bodyParam? }'),
  'registerTool.mapping.pathParams': field('string[]'),
  'registerTool.mapping.queryParams': field('string[]'),
  'registerTool.mapping.bodyParam': field('string'),
  'registerTool.serverUrl': field('string'),
  'registerTool.mcpToolName': field('string'),
  'registerTool.profile': field('ProfileId'),
  'registerTool.answeredBy': {
    ...field("'page'", ['page']),
    unset: 'Its handler',
  },
  'registerTool.maxResponseBytes': {
    ...field('number'),
    unset: 'No limit',
  },
  'registerTool.session': {
    ...field('McpSessionLimits'),
    unset: 'No limits',
  },
  'registerTool.session.idleMs': {
    ...field('number'),
    unset: 'No limit',
  },
  'registerTool.session.max': {
    ...field('number'),
    unset: 'No limit',
  },
  'registerTool.maxCallsPerTurn': {
    ...field('number'),
    unset: 'As many as its steps allow',
  },
  'registerTool.fieldText': {
    ...field('Partial<Record<keyof AgentToolInput, string>>'),
    unset: 'The fields carry no text',
  },
  'registerTool.hostFields': {
    ...field('Record<string, ZodType>'),
    unset: 'The input is only what the profile takes',
  },
  'registerTool.hostOnly': {
    ...field("Array<'attachments' | 'voice' | 'options' | 'speech'>"),
    unset: 'The model can fill every channel the profile takes',
  },
  'registerTool.auth': {
    ...field('ToolAuthConfig'),
    unset: 'No credential',
  },
  'registerTool.auth.type': field(
    unionType(TOOL_AUTH_TYPES),
    TOOL_AUTH_TYPES,
    OPTION_DOCS.TOOL_AUTH_TYPES,
  ),
  'registerTool.auth.slot': field('string'),
  'registerTool.auth.service': field('string'),
  'registerTool.auth.headerName': {
    ...field('string'),
    unset: 'Authorization',
  },
  'registerTool.auth.headerPrefix': {
    ...field('string'),
    unset: '"Bearer " for tokens, nothing for API keys',
  },
  'registerTool.auth.queryParam': {
    ...field('string'),
    unset: 'The key goes in a header',
  },
  'registerTool.auth.onUnauthenticated': {
    ...field(
      unionType(AUTH_UNAUTHENTICATED_POLICIES),
      AUTH_UNAUTHENTICATED_POLICIES,
      OPTION_DOCS.AUTH_UNAUTHENTICATED_POLICIES,
    ),
    unset: 'gate',
  },
  'registerTool.auth.preResolved': field('Partial<OAuthEndpoints & { resource: string }>'),
  'registerTool.auth.scopes': field('string[]'),
  'registerTool.auth.clientId': field('string'),
  'registerTool.auth.redirectUri': field('string'),
  'studio.authType': field(
    unionType(STUDIO_AUTH_TYPES),
    STUDIO_AUTH_TYPES,
    OPTION_DOCS.STUDIO_AUTH_TYPES,
  ),
  'studio.testCredential': field('string'),
  'studio.stubOutput': {
    ...field('Record<string, unknown>'),
    unset: 'A stand-in built from the output schema',
  },
  'studio.sampleInput': field('Record<string, unknown>'),
  'registerTool.inputSchema': field('Record<string, unknown>'),
  'registerTool.outputSchema': field('Record<string, unknown>'),
  'registerStructured.jsonSchema': field('Record<string, unknown>'),
  'registerTool.access': field(unionType(TOOL_ACCESS), TOOL_ACCESS, OPTION_DOCS.TOOL_ACCESS),
  'registerTool.loadTier': field(
    unionType(TOOL_LOAD_TIERS),
    TOOL_LOAD_TIERS,
    OPTION_DOCS.TOOL_LOAD_TIERS,
  ),
  'registerTool.permission': field(
    unionType(TOOL_PERMISSION),
    TOOL_PERMISSION,
    OPTION_DOCS.TOOL_PERMISSION,
  ),
  'registerTool.preTool': field('(input, ctx) => StageResult | undefined'),
  'registerTool.exposeToModel': {
    ...field('boolean'),
    unset: 'The model can',
  },
  'registerTool.sources': field('(output) => Source[]'),
  'registerTool.images': field('(output) => string[]'),
  'registerTool.imageLimits': {
    ...field('ToolImageLimits'),
    unset: 'No limit',
  },
  'registerTool.askInputSchema': field('Record<string, unknown>'),
  'registerTool.conflictsWith': field('string[]'),
  'registerTool.limit': {
    ...field('HttpToolLimit'),
    unset: 'No limit',
  },
  'registerTool.timeoutMs': {
    ...field('number'),
    unset: "As long as the caller's signal lets it",
  },
  'registerTool.after': {
    ...field('boolean'),
    unset: 'The model sets no order',
  },
  'registerTool.background': {
    ...field(
      "'always' | { afterMs: number } | 'ask' | 'never'",
      TOOL_BACKGROUND_MODES,
      OPTION_DOCS.TOOL_BACKGROUND_MODES,
    ),
    unset: "'never': the model gets its reply when the body ends",
  },
  'registerTool.background.afterMs': field('number'),
  'registerTool.category': field('string'),
  'registerTool.labels': field('ToolLabels'),
  'registerTool.labels.activity': {
    ...field('string | string[]'),
    unset: 'The tool name, in words',
  },
  'registerTool.labels.activityPast': {
    ...field('string | string[]'),
    unset: 'The tool name, in words',
  },
  'registerTool.labels.activityFailed': {
    ...field('string | string[]'),
    unset: "Couldn't complete, then the tool name in words",
  },
  'registerTool.labels.request': {
    ...field('string | string[]'),
    unset: 'The tool name, in words',
  },
  'registerTool.paths': {
    ...field('string[]'),
    unset: 'Every path',
  },
});
/** `labels.<key>` resolves to `labels.*` with that key's own note. */
export function fieldMeta(path: string): FieldMeta | undefined {
  const meta = PROFILE_FIELDS[path] ?? EXTRA_FIELDS[path];
  if (meta || !path.startsWith('labels.')) return meta;
  const key = path.slice('labels.'.length);
  const wildcard = PROFILE_FIELDS['labels.*'];
  if (!wildcard || !Object.hasOwn(LABEL_NOTES, key)) return undefined;
  return { ...wildcard, doc: LABEL_NOTES[key as LabelKey] };
}
/** A setting the catalog cannot hold: where it is written, and why. */
export interface FieldProblem {
  path: string;
  message: string;
}

const isText = (value: unknown) => typeof value === 'string';
const isTextList = (value: unknown) => Array.isArray(value) && value.every(isText);

const PLAIN_KINDS: Readonly<Record<string, (value: unknown) => boolean>> = {
  string: isText,
  ModelId: isText,
  ProfileId: isText,
  ToolId: isText,
  KeySlot: isText,
  number: (value) => typeof value === 'number',
  boolean: (value) => typeof value === 'boolean',
  'string[]': isTextList,
  'ToolId[]': isTextList,
  'BuiltinToolId[]': isTextList,
};

/** Why `value` cannot be `meta`'s field. A range or a shape stays with the check that owns it. */
function valueProblem(meta: FieldMeta, value: unknown): string | undefined {
  const { options, type } = meta;
  if (value === null) return undefined;
  if (options && (typeof value === 'string' || /^'[^{]*$/.test(type))) {
    if (options.includes(value as string)) return undefined;
    return `${JSON.stringify(value)} is not one of ${options.map((option) => `'${option}'`).join(', ')}.`;
  }
  const isKind = PLAIN_KINDS[type];
  return !isKind || isKind(value) ? undefined : `has to be a ${type}.`;
}

/** Each object path of the catalog, with the keys it takes. */
function keysByParent(fields: Record<string, FieldMeta>): Map<string, Set<string>> {
  const children = new Map<string, Set<string>>([['', new Set()]]);
  for (const path of Object.keys(fields)) {
    const parent = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : '';
    children.set(
      parent,
      (children.get(parent) ?? new Set()).add(path.slice(parent.length && parent.length + 1)),
    );
  }
  return children;
}

/** What is wrong with the value at `at`, as the object `parent` of the catalog: its form or its keys. */
function shapeProblems(
  at: string,
  value: unknown,
  parent: string,
  keys: Set<string>,
  meta: FieldMeta | undefined,
): FieldProblem[] {
  if (value === null) return [];
  if (typeof value !== 'object' || Array.isArray(value)) {
    if (!parent || /\||\[\]/.test(meta?.type ?? '')) return [];
    return [{ path: at, message: `has to be an object of ${[...keys].join(', ')}.` }];
  }
  return Object.keys(value)
    .filter((key) => !keys.has(key))
    .map((key) => ({
      path: at ? `${at}.${key}` : key,
      message: `is not a setting; ${at || 'this'} takes ${[...keys].join(', ')}.`,
    }));
}

/** The problems of `root` against `fields`, each keyed by the path of keys it names. */
function fieldProblems(root: unknown, fields: Record<string, FieldMeta>): FieldProblem[] {
  const problems: FieldProblem[] = [];
  for (const [parent, keys] of keysByParent(fields)) {
    // why: A detector's own settings are `detectProblem`'s: which it takes depends on the detector.
    if (keys.has('*') || parent.startsWith('guardrails.detect')) continue;
    for (const [at, value] of parent ? valuesAt(root, parent.split('.')) : [['', root] as const]) {
      problems.push(...shapeProblems(at, value, parent, keys, fields[parent]));
    }
  }
  for (const [path, meta] of Object.entries(fields)) {
    for (const [at, value] of valuesAt(root, path.split('.'))) {
      const message = valueProblem(meta, value);
      if (message) problems.push({ path: at, message });
    }
  }
  return problems;
}

const PROFILE_CATALOG = Object.fromEntries(
  Object.entries(PROFILE_FIELDS).map(([path, meta]) => [profileKeysOf(path).join('.'), meta]),
);

/** Every setting in a profile definition that the catalog cannot hold. Nothing here needs a complete profile. */
export function profileFieldProblems(profile: unknown): FieldProblem[] {
  return fieldProblems(profile, PROFILE_CATALOG);
}

const TOOL_CATALOG = Object.fromEntries(
  Object.entries(EXTRA_FIELDS)
    .filter(([path]) => path.startsWith('registerTool.'))
    .map(([path, meta]) => [path.slice('registerTool.'.length), meta]),
);

/** Every setting in a tool definition that the catalog cannot hold. Nothing here needs a complete tool. */
export function toolFieldProblems(tool: unknown): FieldProblem[] {
  return fieldProblems(tool, TOOL_CATALOG);
}

export { API_EXPORTS, type ApiExportMeta, REQUEST_FIELDS } from './api-catalog.ts';
export type {
  ProfileGraphEditor,
  ProfileGraphFacet,
  ProfileGraphFacetId,
  ProfileGraphRole,
} from './profile-graph.ts';
export { PROFILE_GRAPH, profileGraphFacet, spineFacetsForProfileType } from './profile-graph.ts';
