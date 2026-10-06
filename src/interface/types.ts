import type { Boundary } from '../guardrails/boundaries.ts';
import type { DetectAction, DetectMatrix, Detector, UrlDetector } from '../guardrails/detectors.ts';
import type { LexiconOverrides } from '../guardrails/lexicon.ts';
import type { ResolvedGuardrailPolicy } from '../guardrails/types.ts';
import type {
  LiveProfileToolsSpec,
  ProfileToolsSpec,
  ToolCallEdit,
  ToolPhaseEvent,
} from '../kernel/tools/types.ts';
import type {
  AttachmentValidationIssue,
  CompactionSpec,
  GroundingEvent,
  ImageProfile,
  LiveProfile,
  ModelBinding,
  ModelId,
  ProfileOutputsSpec,
  ProviderEvidence,
  Source,
  SpeechProfile,
  TextProfile,
  TurnStop,
  TurnTokens,
} from '../kernel/types.ts';
import type { ResolvedObservabilityPolicy } from '../observability/types.ts';

/** What a URL detector lets through besides the given URLs, with its defaults applied. */
export interface UrlAllowView {
  hosts: string[];
  fromTools: boolean;
}

/** Whose patterns one detector reads with: the host's are named, never shown. */
export interface DetectorPatternsView {
  /** Whether Theorem's own patterns run. */
  theorem: boolean;
  /** The names of the host's patterns. */
  names: string[];
}

/** A detector of the host's own: what it is called and where it applies, never what it matches. */
export interface HostDetectorView {
  /** Its key in `guardrails.detect`, as in `acme.record`. Its rule is `detect.<id>`. */
  id: string;
  label: string;
  /** Its action at every boundary. */
  actions: Record<Boundary, DetectAction>;
  /** The names of its patterns. */
  names: string[];
  /** Whether it also reads with a function of the host's. */
  find: boolean;
}

/** Guardrails visible to UI — egress enforcer functions are omitted. */
export type ProfileGuardrailsView = Pick<ResolvedGuardrailPolicy, 'quota' | 'blockedReply'> & {
  /** Every detector's action at every boundary. */
  detect: DetectMatrix;
  /** Whose patterns a detector reads with, for each one the profile changed it for. */
  patterns?: Partial<Record<Detector, DetectorPatternsView>>;
  /** The host's own detectors, in the order the profile lists them. The kernel reads with them. */
  host?: HostDetectorView[];
  /** What `ungiven_images` and `ungiven_links` let through. */
  allow: Record<UrlDetector, UrlAllowView>;
  /** Whether the host's own `egress.enforce` judges the reply. */
  hasEgress: boolean;
};

/** Observability visible to UI — TraceSink / onWriteError functions are omitted. */
export type ProfileObservabilityView = Pick<
  ResolvedObservabilityPolicy,
  'record' | 'sampleRate' | 'include' | 'scrub' | 'resource' | 'retainForDays' | 'rotateAfterMiB'
> & {
  /** false | registered id | 'custom' when writeTo is an inline TraceSink; absent when unset. */
  writeTo?: false | string;
  hasOnWriteError: boolean;
};

/** Resolved `inputs` — `ProfileInputsSpec` plus `acceptAttr` for file pickers. */
export interface ProfileInputsInterface {
  text: boolean;
  attachments: { accept: string[]; acceptAttr: string } | null;
  voice: { accept: string[] } | null;
  maxFiles?: number;
  maxBytes?: number;
  maxTurnBytes?: number;
  limitsByMime?: Record<string, number>;
  slots?: Record<string, string[]>;
}

/** A tool's definition (handler, schemas, endpoint, headers) stays on the host; `t1Policy` too. */
export type ProfileToolsView = Pick<ProfileToolsSpec, 'allow' | 't2Loader'>;

/** A model binding as the interface carries it: a compaction `trigger` is a host function. */
export type ModelBindingView = Omit<ModelBinding, 'compaction'> & {
  compaction?: Omit<CompactionSpec, 'trigger'>;
};

/** `profile.outputs` as the interface carries it: validators are host functions. */
export type ProfileOutputsView = Omit<ProfileOutputsSpec, 'validation'>;

/** What the text, image and speech interfaces carry in place of their profile's own fields. */
export type ComposerInterfaceFields = {
  models: Record<ModelId, ModelBindingView>;
  outputs?: ProfileOutputsView;
  /** Client keys' overrides (`CLIENT_LEXICON_KEYS`), resolved on the host; pass to `lexiconText`. */
  lexicon: LexiconOverrides;
  inputs: ProfileInputsInterface;
  guardrails?: ProfileGuardrailsView;
  observability?: ProfileObservabilityView;
  /** Always true — composer turns cancel via `TurnRequest.signal`. */
  canStop: true;
};

/** A text profile as a client sees it, without its server-only fields. */
export type TextProfileInterface = Omit<
  TextProfile,
  'inputs' | 'tools' | 'guardrails' | 'observability' | 'lexicon' | 'models' | 'outputs'
> &
  ComposerInterfaceFields & {
    tools: ProfileToolsView;
    /** From `turnBehaviour.allowSteering` (default true on text). */
    allowSteering: boolean;
  };

/** An image profile as a client sees it, without its server-only fields. */
export type ImageProfileInterface = Omit<
  ImageProfile,
  'inputs' | 'tools' | 'guardrails' | 'observability' | 'lexicon' | 'models' | 'outputs'
> &
  ComposerInterfaceFields & { tools: ProfileToolsView };

/** A speech profile as a client sees it, without its server-only fields. */
export type SpeechProfileInterface = Omit<
  SpeechProfile,
  'guardrails' | 'observability' | 'lexicon' | 'models' | 'outputs'
> &
  ComposerInterfaceFields;

/** A live profile as a client sees it, without its server-only fields. */
export type LiveProfileInterface = Omit<
  LiveProfile,
  'tools' | 'guardrails' | 'observability' | 'lexicon' | 'models'
> & {
  models: Record<ModelId, ModelBindingView>;
  /** Client keys' overrides (`CLIENT_LEXICON_KEYS`), resolved on the host; pass to `lexiconText`. */
  lexicon: LexiconOverrides;
  tools: LiveProfileToolsSpec;
  guardrails?: ProfileGuardrailsView;
  observability?: ProfileObservabilityView;
};

/** Any profile as a client sees it. */
export type ProfileInterface =
  | TextProfileInterface
  | ImageProfileInterface
  | SpeechProfileInterface
  | LiveProfileInterface;

/** Turn/chat composer profiles — excludes live (realtime streams, no turn inputs block). */
export type ComposerProfileInterface = Exclude<ProfileInterface, LiveProfileInterface>;

/** The kinds of block a transcript holds. */
export type TranscriptBlockKind =
  | 'user-text'
  | 'user-attachment'
  | 'user-voice'
  | 'thought'
  | 'text'
  | 'tool'
  | 'structured'
  | 'media'
  | 'grounding'
  | 'citation'
  | 'evidence'
  | 'error'
  | 'turn-done';

export interface TranscriptBlockBase {
  id: string;
  kind: TranscriptBlockKind;
}

export interface UserTextBlock extends TranscriptBlockBase {
  kind: 'user-text';
  text: string;
}

export interface UserAttachmentBlock extends TranscriptBlockBase {
  kind: 'user-attachment' | 'user-voice';
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Optional base64 payload for inline image/audio preview in the host UI. */
  data?: string;
}

export interface ThoughtBlock extends TranscriptBlockBase {
  kind: 'thought';
  text: string;
}

export interface TextBlock extends TranscriptBlockBase {
  kind: 'text';
  text: string;
}

/** Where a call stands: the latest phase that changes its status. */
export type ToolCallState = Extract<
  ToolPhaseEvent,
  { phase: 'running' | 'gate' | 'complete' | 'error' | 'cancel' }
>;

/** One tool call: the model's raw call joined with its phase events by `callId` (`toolCallsOf`). */
export interface ToolCall {
  name: string;
  callId: string;
  /** What the model proposed. */
  arguments: Record<string, unknown>;
  /** The call's `ToolCallRequest.thoughtSignature`: history replays the call with it. */
  thoughtSignature?: string;
  /** The call's `ToolCallRequest.stepId`: calls sharing it replay as one assistant message. */
  stepId?: string;
  /** The user's edit on approval; `to` is what ran. */
  edited?: ToolCallEdit;
  /** What the call is doing, in the tool's words, from its last `running` phase. */
  activity?: string;
  /** What the call did, from its `complete` phase. */
  activityPast?: string;
  /** Absent while the call has only been made. */
  state?: ToolCallState;
  /** When it last started running (epoch ms). */
  startedAt?: number;
  /** When it last settled: complete, failed, cancelled or gated (epoch ms). */
  endedAt?: number;
  artifacts: unknown[];
}

export interface ToolBlock extends TranscriptBlockBase {
  kind: 'tool';
  tool: ToolCall;
}

export interface StructuredBlock extends TranscriptBlockBase {
  kind: 'structured';
  value: unknown;
}

export interface MediaBlock extends TranscriptBlockBase {
  kind: 'media';
  mimeType: string;
  /** Base64 for model-generated or attached media. Absent when `url` is set. */
  data?: string;
  /** Remote http(s) URL promoted from completed tool output. Absent when `data` is set. */
  url?: string;
  /** A smaller copy of `url` for previews, when the tool output offered one. */
  previewUrl?: string;
}

export interface GroundingBlock extends TranscriptBlockBase {
  kind: 'grounding';
  grounding: GroundingEvent;
}

/** Sources a provider or a tool cited; `callId` names the tool call when a tool did. */
export interface CitationBlock extends TranscriptBlockBase {
  kind: 'citation';
  sources: Source[];
  callId?: string;
}

export interface EvidenceBlock extends TranscriptBlockBase {
  kind: 'evidence';
  evidence: ProviderEvidence;
}

export interface ErrorBlock extends TranscriptBlockBase {
  kind: 'error';
  message: string;
}

export interface TurnDoneBlock extends TranscriptBlockBase {
  kind: 'turn-done';
  stop?: TurnStop;
  tokens?: TurnTokens;
  interactionId?: string;
  compaction?: boolean;
  /**
   * How long the reply has worked so far (ms), approval waits excluded. The host
   * client stamps it when a run ends, so the time travels with the transcript.
   */
  workedMs?: number;
  /** When the reply last stopped (epoch ms), stamped with `workedMs`. */
  endedAt?: number;
}

/** One block of a transcript: a message, an attachment, a thought, a tool call or a notice. */
export type TranscriptBlock =
  | UserTextBlock
  | UserAttachmentBlock
  | ThoughtBlock
  | TextBlock
  | ToolBlock
  | StructuredBlock
  | MediaBlock
  | GroundingBlock
  | CitationBlock
  | EvidenceBlock
  | ErrorBlock
  | TurnDoneBlock;

/** A file the user has picked but not yet sent. */
export interface PendingAttachment {
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Optional base64 payload copied onto the transcript block for UI preview. */
  data?: string;
}

/** Whether the pending attachments pass the profile's limits, and the issues if not. */
export interface AttachmentValidationResult {
  ok: boolean;
  issues: AttachmentValidationIssue[];
}

/** What the user has composed and not yet sent. */
export interface UserTurnDraft {
  text?: string;
  attachments?: PendingAttachment[];
  voice?: PendingAttachment[];
}

/** Options for folding turn events into transcript blocks. */
export interface FoldTurnEventsOptions {
  showThoughts?: boolean;
  idPrefix?: string;
}

/** True unless the profile turns thought streaming off. */
function streamThoughtsEnabled(outputs?: ProfileOutputsSpec): boolean {
  return outputs?.streaming?.streamThoughts !== false;
}

export { streamThoughtsEnabled };
