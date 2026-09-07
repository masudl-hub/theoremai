/**
 * Headless interface contracts — profile-driven UI spec and transcript blocks.
 *
 * `ProfileInterface` is `Profile` with resolved `inputs`/`tools` and a serializable
 * `guardrails` view. No parallel schema.
 *
 * @module
 */

import type { ProfileToolsSpec } from '../kernel/tools/types.ts';
import type {
  ControlId,
  GroundingEvent,
  ImageProfile,
  LiveProfile,
  ModelId,
  Profile,
  ProfileGuardrailsSpec,
  ProfileModelSpec,
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

/** Guardrails visible to UI — egress enforcer functions are omitted. */
export type ProfileGuardrailsView = Pick<
  ProfileGuardrailsSpec,
  'quota' | 'canary' | 'sanitizeInput' | 'redactSensitive'
> & {
  hasEgress: boolean;
};

/** `profile.model` with normalized `select` / `controls`. */
export type NormalizeModel<M extends ProfileModelSpec = ProfileModelSpec> = M & {
  select: Record<string, ModelId> | null;
  controls: ControlId[];
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

/** `profile.tools` plus resolved registry entries. */
export type ResolvedTools = ProfileToolsSpec & {
  resolved: Array<RegisteredTool | { name: ToolId; missing: true }>;
};

export type NormalizedModel = NormalizeModel;

export type TextProfileInterface = Omit<
  TextProfile,
  'inputs' | 'tools' | 'guardrails' | 'model'
> & {
  model: NormalizeModel<TextProfile['model']>;
  inputs: ProfileInputsInterface;
  tools: ResolvedTools;
  guardrails?: ProfileGuardrailsView;
};

export type ImageProfileInterface = Omit<
  ImageProfile,
  'inputs' | 'tools' | 'guardrails' | 'model'
> & {
  model: NormalizeModel<ImageProfile['model']>;
  inputs: ProfileInputsInterface;
  tools: ResolvedTools;
  guardrails?: ProfileGuardrailsView;
};

export type SpeechProfileInterface = Omit<SpeechProfile, 'guardrails' | 'model'> & {
  model: NormalizeModel<SpeechProfile['model']>;
  inputs: ProfileInputsInterface;
  guardrails?: ProfileGuardrailsView;
};

export type LiveProfileInterface = Omit<
  LiveProfile,
  'inputs' | 'tools' | 'model' | 'guardrails'
> & {
  model: NormalizeModel<LiveProfile['model']>;
  inputs: ProfileInputsInterface;
  tools: ResolvedTools;
  guardrails?: ProfileGuardrailsView;
};

export type ProfileInterface =
  | TextProfileInterface
  | ImageProfileInterface
  | SpeechProfileInterface
  | LiveProfileInterface;

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
  data: string;
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
