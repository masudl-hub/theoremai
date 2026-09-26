/**
 * Headless profile-driven interface — spec, inputs, transcript folding,
 * composer pending intents (stash / queue / steer).
 *
 * @module
 */

export type {
  AttachmentValidationCode,
  AttachmentValidationIssue,
  AttachmentValidationParams,
} from '../kernel/types.ts';
export {
  buildUserTurnBlocks,
  foldConversationTurn,
  foldTurnEvents,
  resetBlockIds,
} from './blocks.ts';
export type {
  ComposerActionContext,
  ComposerMenuAction,
  ComposerPrimaryAction,
  ComposerRunPhase,
} from './composer-actions.ts';
export { resolveComposerMenuActions, resolveComposerPrimary } from './composer-actions.ts';
export type { PrepareUserTurnResult } from './draft.ts';
export { prepareUserTurn, sanitizeUserDraft } from './draft.ts';
export { interfaceFromProfile, interfaceFromProjected } from './from-profile.ts';
export type { UserTurnHistoryMedia } from './history.ts';
export {
  answerOpenToolCalls,
  appendAssistantEventsToHistory,
  appendPausedTurnToHistory,
  appendToolDenialToHistory,
  appendToolExchangeToHistory,
  appendUserDraftToHistory,
  assertOpenToolCalls,
  historyFromTranscriptBlocks,
  toolReadBack,
  userDraftToSteerInject,
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
  effortSelectEnabled,
  generationSelectEnabled,
  interfaceEffortOptions,
  interfaceModelOptions,
  modelSelectEnabled,
} from './models.ts';
export type {
  ComposerPendingKind,
  ComposerPendingMessage,
  CreateComposerPendingMessageArgs,
} from './pending.ts';
export {
  COMPOSER_PENDING_KINDS,
  cloneUserTurnDraft,
  composerPendingPreview,
  consumeNextComposerQueue,
  consumeNextComposerSteer,
  convertSteersToFrontQueued,
  createComposerPendingMessage,
  moveComposerPendingWithinKind,
  orderComposerPendingMessages,
  promoteComposerPendingKind,
  removeComposerPendingMessage,
  removeLandedSteers,
  updateComposerPendingDraft,
  userDraftHasPayload,
} from './pending.ts';
export { profileInterfaceSchema } from './profile-interface.ts';
export type {
  AwaitingToolContext,
  GatedToolContext,
  InterfaceTurnSession,
  ToolGateAuth,
} from './session.ts';
export {
  applyTurnEventsToSession,
  awaitingFromEvents,
  branchInterfaceTurnSession,
  emptyInterfaceTurnSession,
  gatedToolFromEvents,
  gatedToolsFromEvents,
} from './session.ts';
export { toolCallRanWith, toolCallsOf } from './tool-calls.ts';
export { promotedToolIdsFromEvents, toolSnapshotFromEvents } from './tool-invoke.ts';
export type { PromotedToolMedia } from './tool-media.ts';
export {
  collectPromotedMediaFromToolOutput,
  promotedMediaFromUrlString,
} from './tool-media.ts';
export type {
  AttachmentValidationResult,
  ComposerInterfaceFields,
  ComposerProfileInterface,
  FoldTurnEventsOptions,
  ImageProfileInterface,
  LiveProfileInterface,
  ModelBindingView,
  PendingAttachment,
  ProfileGuardrailsView,
  ProfileInputsInterface,
  ProfileInterface,
  ProfileObservabilityView,
  ProfileOutputsView,
  ProfileToolsView,
  SpeechProfileInterface,
  TextProfileInterface,
  TranscriptBlock,
  TranscriptBlockKind,
  UserTurnDraft,
} from './types.ts';
export { streamThoughtsEnabled } from './types.ts';
