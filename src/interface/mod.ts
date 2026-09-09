/**
 * Headless profile-driven interface — spec, inputs, transcript folding,
 * composer pending intents (stash / queue / steer).
 *
 * @module
 */

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
export {
  COMPOSER_MENU_ACTION_DESCRIPTIONS,
  COMPOSER_MENU_ACTION_LABELS,
  COMPOSER_PRIMARY_LABELS,
  resolveComposerMenuActions,
  resolveComposerPrimary,
} from './composer-actions.ts';
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
  defaultInterfaceModel,
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
  updateComposerPendingDraft,
  userDraftHasPayload,
} from './pending.ts';
export type { InterfaceTurnSession, PausedToolContext } from './session.ts';
export {
  applyTurnEventsToSession,
  branchInterfaceTurnSession,
  emptyInterfaceTurnSession,
  pausedToolFromEvents,
} from './session.ts';
export { promotedToolIdsFromEvents, toolSnapshotFromEvents } from './tool-invoke.ts';
export type { PromotedToolMedia } from './tool-media.ts';
export {
  collectPromotedMediaFromToolOutput,
  promotedMediaFromUrlString,
} from './tool-media.ts';
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
  ProfileObservabilityView,
  ResolvedTools,
  SpeechProfileInterface,
  TextProfileInterface,
  TranscriptBlock,
  TranscriptBlockKind,
  UserTurnDraft,
} from './types.ts';
export { streamThoughtsEnabled } from './types.ts';
