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
export type { UserTurnHistoryMedia } from './history.ts';
export {
  appendAssistantEventsToHistory,
  appendToolDenialToHistory,
  appendToolExchangeToHistory,
  appendUserDraftToHistory,
  historyFromTranscriptBlocks,
} from './history.ts';
export {
  attachmentAcceptAttr,
  inputsFromSpec,
  pickMediaRecorderMime,
  validateProfileInputs,
} from './inputs.ts';
export type { InterfaceEffortOption, InterfaceModelOption } from './models.ts';
export {
  defaultInterfaceEffort,
  defaultInterfaceModel,
  effortSelectEnabled,
  generationSelectEnabled,
  interfaceEffortOptions,
  interfaceModelOptions,
  modelSelectEnabled,
} from './models.ts';
export type { InterfaceTurnSession, PausedToolContext } from './session.ts';
export {
  applyTurnEventsToSession,
  branchInterfaceTurnSession,
  emptyInterfaceTurnSession,
  pausedToolFromEvents,
} from './session.ts';
export { promotedToolIdsFromEvents, toolSnapshotFromEvents } from './tool-invoke.ts';
export type {
  AttachmentValidationCode,
  AttachmentValidationIssue,
  AttachmentValidationResult,
  ComposerProfileInterface,
  FoldTurnEventsOptions,
  ImageProfileInterface,
  LiveProfileInterface,
  LiveResolvedTools,
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
