/**
 * Headless interface contracts — profile-driven UI spec and transcript blocks.
 *
 * `ProfileInterface` is `Profile` with resolved `inputs`/`tools` and serializable
 * `guardrails` / `observability` views. No parallel schema.
 *
 * @module
 */

import type { ResolvedGuardrailPolicy } from '../guardrails/types.ts';
import type { LiveProfileToolsSpec, ProfileToolsSpec } from '../kernel/tools/types.ts';
import type {
  GroundingEvent,
  ImageProfile,
  LiveProfile,
  Profile,
  ProfileOutputsSpec,
  ProjectedProfile,
  ProviderEvidenceEvent,
  RegisteredTool,
  SpeechProfile,
  TextProfile,
  ToolCallEvent,
  ToolId,
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
  'record' | 'sampleRate' | 'include' | 'scrub' | 'retainForDays' | 'rotateAfterMiB'
> & {
  /** false | registered id | 'custom' when writeTo is an inline TraceSink. */
  writeTo: false | string | 'custom' | undefined;
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

/** `profile.tools` plus resolved registry entries (turn profiles). */
export type ResolvedTools = ProfileToolsSpec & {
  resolved: Array<RegisteredTool | { name: ToolId; missing: true }>;
};

/** Live `profile.tools` — allowlist only, plus resolved registry entries. */
export type LiveResolvedTools = LiveProfileToolsSpec & {
  resolved: Array<RegisteredTool | { name: ToolId; missing: true }>;
};

export type TextProfileInterface = Omit<
  TextProfile,
  'inputs' | 'tools' | 'guardrails' | 'observability'
> & {
  inputs: ProfileInputsInterface;
  tools: ResolvedTools;
  guardrails?: ProfileGuardrailsView;
  observability?: ProfileObservabilityView;
  /** Always true — composer turns cancel via `TurnRequest.signal`. */
  canStop: true;
  /** From `turnBehaviour.allowSteering` (default true on text). */
  allowSteering: boolean;
};

export type ImageProfileInterface = Omit<
  ImageProfile,
  'inputs' | 'tools' | 'guardrails' | 'observability'
> & {
  inputs: ProfileInputsInterface;
  tools: ResolvedTools;
  guardrails?: ProfileGuardrailsView;
  observability?: ProfileObservabilityView;
  /** Always true — composer turns cancel via `TurnRequest.signal`. */
  canStop: true;
};

export type SpeechProfileInterface = Omit<SpeechProfile, 'guardrails' | 'observability'> & {
  inputs: ProfileInputsInterface;
  guardrails?: ProfileGuardrailsView;
  observability?: ProfileObservabilityView;
  /** Always true — composer turns cancel via `TurnRequest.signal`. */
  canStop: true;
};

export type LiveProfileInterface = Omit<LiveProfile, 'tools' | 'guardrails' | 'observability'> & {
  tools: LiveResolvedTools;
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

export type ProfileInterfaceSource = Profile | ProjectedProfile;

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

export interface ToolBlock extends TranscriptBlockBase {
  kind: 'tool';
  tool: ToolCallEvent & { id?: string };
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
}

export interface GroundingBlock extends TranscriptBlockBase {
  kind: 'grounding';
  grounding: GroundingEvent;
}

export interface EvidenceBlock extends TranscriptBlockBase {
  kind: 'evidence';
  evidence: ProviderEvidenceEvent;
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

export type AttachmentValidationCode =
  | 'mime_not_allowed'
  | 'too_many_files'
  | 'file_too_large'
  | 'turn_too_large'
  | 'limits_unconfigured';

export interface AttachmentValidationIssue {
  code: AttachmentValidationCode;
  message: string;
  fileName?: string;
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
