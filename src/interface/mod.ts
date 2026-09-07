/**
 * Headless profile-driven interface — spec, inputs, transcript folding.
 *
 * @module
 */

export {
  buildUserTurnBlocks,
  foldConversationTurn,
  foldTurnEvents,
  resetBlockIds,
} from './blocks.ts';
export type { PrepareUserTurnResult } from './draft.ts';
export { prepareUserTurn, sanitizeUserDraft } from './draft.ts';
export { interfaceFrom, interfaceFromProfile, interfaceFromProjected } from './from-profile.ts';
export {
  attachmentAcceptAttr,
  inputsFromSpec,
  pickMediaRecorderMime,
  validateProfileInputs,
} from './inputs.ts';
export type {
  AttachmentValidationCode,
  AttachmentValidationIssue,
  AttachmentValidationResult,
  ComposerProfileInterface,
  FoldTurnEventsOptions,
  ImageProfileInterface,
  LiveProfileInterface,
  LiveResolvedTools,
  NormalizedModel,
  NormalizeModel,
  PendingAttachment,
  ProfileGuardrailsView,
  ProfileInputsInterface,
  ProfileInterface,
  ProfileInterfaceSource,
  ResolvedTools,
  SpeechProfileInterface,
  TextProfileInterface,
  TranscriptBlock,
  TranscriptBlockKind,
  UserTurnDraft,
} from './types.ts';
export { streamThoughtsEnabled } from './types.ts';
