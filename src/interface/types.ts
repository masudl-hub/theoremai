/**
 * Headless interface contracts — profile-driven UI spec and transcript blocks.
 *
 * `ProfileInterface` is `Profile` as JSON: resolved `inputs`, tool ids, and
 * views of `models`, `outputs`, `guardrails` and `observability` without host
 * functions. `profileInterfaceSchema` is its one schema.
 *
 * @module
 */

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

/** Guardrails visible to UI — egress enforcer functions are omitted. */
export type ProfileGuardrailsView = Pick<
  ResolvedGuardrailPolicy,
  'quota' | 'canary' | 'sanitizeInput' | 'redactSensitive'
> & {
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

/**
 * `profile.tools` as the interface carries it: tool ids. A tool's definition
 * (its handler, schemas, endpoint, headers) stays on the host; `t1Policy` is a
 * host function.
 */
export type ProfileToolsView = Pick<ProfileToolsSpec, 'allow' | 't2Loader'>;

/** A model binding as the interface carries it: a compaction `trigger` is a host function. */
export type ModelBindingView = Omit<ModelBinding, 'compaction'> & {
  compaction?: Omit<CompactionSpec, 'trigger'>;
};

/** `profile.outputs` as the interface carries it: validators are host functions. */
export type ProfileOutputsView = Omit<ProfileOutputsSpec, 'validation'>;

/** Model fields every interface carries. */
type ModelFieldsView = {
  models: Record<ModelId, ModelBindingView>;
};

export type TextProfileInterface = Omit<
  TextProfile,
  'inputs' | 'tools' | 'guardrails' | 'observability' | 'lexicon' | 'models' | 'outputs'
> &
  ModelFieldsView & {
    outputs?: ProfileOutputsView;
    /** Client keys' overrides (`CLIENT_LEXICON_KEYS`), resolved on the host; pass to `lexiconText`. */
    lexicon: LexiconOverrides;
    inputs: ProfileInputsInterface;
    tools: ProfileToolsView;
    guardrails?: ProfileGuardrailsView;
    observability?: ProfileObservabilityView;
    /** Always true — composer turns cancel via `TurnRequest.signal`. */
    canStop: true;
    /** From `turnBehaviour.allowSteering` (default true on text). */
    allowSteering: boolean;
  };

export type ImageProfileInterface = Omit<
  ImageProfile,
  'inputs' | 'tools' | 'guardrails' | 'observability' | 'lexicon' | 'models' | 'outputs'
> &
  ModelFieldsView & {
    outputs?: ProfileOutputsView;
    /** Client keys' overrides (`CLIENT_LEXICON_KEYS`), resolved on the host; pass to `lexiconText`. */
    lexicon: LexiconOverrides;
    inputs: ProfileInputsInterface;
    tools: ProfileToolsView;
    guardrails?: ProfileGuardrailsView;
    observability?: ProfileObservabilityView;
    /** Always true — composer turns cancel via `TurnRequest.signal`. */
    canStop: true;
  };

export type SpeechProfileInterface = Omit<
  SpeechProfile,
  'guardrails' | 'observability' | 'lexicon' | 'models' | 'outputs'
> &
  ModelFieldsView & {
    outputs?: ProfileOutputsView;
    /** Client keys' overrides (`CLIENT_LEXICON_KEYS`), resolved on the host; pass to `lexiconText`. */
    lexicon: LexiconOverrides;
    inputs: ProfileInputsInterface;
    guardrails?: ProfileGuardrailsView;
    observability?: ProfileObservabilityView;
    /** Always true — composer turns cancel via `TurnRequest.signal`. */
    canStop: true;
  };

export type LiveProfileInterface = Omit<
  LiveProfile,
  'tools' | 'guardrails' | 'observability' | 'lexicon' | 'models'
> &
  ModelFieldsView & {
    /** Client keys' overrides (`CLIENT_LEXICON_KEYS`), resolved on the host; pass to `lexiconText`. */
    lexicon: LexiconOverrides;
    tools: LiveProfileToolsSpec;
    guardrails?: ProfileGuardrailsView;
    observability?: ProfileObservabilityView;
  };

export type ProfileInterface =
  | TextProfileInterface
  | ImageProfileInterface
  | SpeechProfileInterface
  | LiveProfileInterface;

/** Turn/chat composer profiles — excludes live (realtime streams, no turn inputs block). */
export type ComposerProfileInterface = Exclude<ProfileInterface, LiveProfileInterface>;

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
  /** Absent while the call has only been made. */
  state?: ToolCallState;
  /** When it last started running (epoch ms). */
  startedAt?: number;
  /** When it last settled: complete, failed, cancelled or gated (epoch ms). */
  endedAt?: number;
  /** Every `artifact` it produced, in order. */
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
  /**
   * Base64 payload for model-generated or attached media.
   * Absent when `url` is set (tool-result URL promotion).
   */
  data?: string;
  /**
   * Remote http(s) URL promoted from completed tool output.
   * Absent when `data` is set (kernel `media` events).
   */
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
}

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

export interface PendingAttachment {
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Optional base64 payload copied onto the transcript block for UI preview. */
  data?: string;
}

export interface AttachmentValidationResult {
  ok: boolean;
  issues: AttachmentValidationIssue[];
}

export interface UserTurnDraft {
  text?: string;
  attachments?: PendingAttachment[];
  voice?: PendingAttachment[];
}

export interface FoldTurnEventsOptions {
  showThoughts?: boolean;
  idPrefix?: string;
}

/** Whether `foldTurnEvents` should emit thought blocks for this profile. */
function streamThoughtsEnabled(outputs?: ProfileOutputsSpec): boolean {
  return outputs?.streaming?.streamThoughts !== false;
}

export { streamThoughtsEnabled };
