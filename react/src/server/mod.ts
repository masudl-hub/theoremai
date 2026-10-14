/**
 * Server half of `@theoremjs/react`: serve one profile to the chat UI, a
 * decision profile to the decision UI, or a host profile's tools to the host UI.
 *
 * @module
 */

export { theoremHostCallRequestSchema } from '../client/host-transport.ts';
export type { LiveClientMessage, LiveOpenMessage } from '../client/live-messages.ts';
export {
  theoremConversationRequestSchema,
  theoremInvokeRequestSchema,
  theoremReplaySchema,
  theoremRewindRequestSchema,
  theoremSteerRequestSchema,
  theoremTurnRequestSchema,
} from '../client/transport.ts';
export { startConversation } from './conversation.ts';
export {
  type ConversationSnapshot,
  type ConversationWriteResult,
  createMemoryConversationStore,
  createSealedConversationStore,
  emptyConversation,
  type PausedReply,
  type SealedConversationStoreOptions,
  type StoredConversation,
  storedConversationSchema,
  type TheoremConversationStore,
  unknownConversation,
} from './conversation-store.ts';
export {
  createMemoryCredentialStore,
  type TheoremCredentialStore,
  type TheoremCredentials,
} from './credential-store.ts';
export {
  createTheoremDecisionHandler,
  type TheoremDecisionHandlerOptions,
} from './decision-handler.ts';
export {
  createTheoremHandler,
  createTheoremHostHandler,
  readBody,
  type TheoremHandlerOptions,
  type TheoremHostHandlerOptions,
  type TheoremRequestContext,
  theoremSession,
  theoremSessionId,
} from './handler.ts';
export {
  createMemoryPageToolBroker,
  type PageToolBroker,
  type PageToolResult,
  pageToolResultSchema,
  sessionPageDispatch,
} from './page-dispatch.ts';
export { checkRequest, parseLiveClientMessage, parseLiveOpenMessage } from './request-check.ts';
export { sessionStateStore } from './session-authority.ts';
export {
  createTheoremSessionBoundary,
  type PreparedLiveOpen,
  type SessionBoundaryOptions,
  type TheoremSessionBoundary,
} from './session-boundary.ts';
export type { TheoremSessionLimits } from './session-limits.ts';
export { resolveSessionLimits } from './session-limits.ts';
export {
  createMemorySessionStore,
  DEFAULT_OPERATION_RETENTION_MS,
  type MemorySessionStoreOptions,
  type PendingToolGate,
  type SessionSnapshot,
  type SessionToolOperation,
  type SessionWriteResult,
  type TheoremSessionState,
  type TheoremSessionStore,
  theoremSessionStateSchema,
} from './session-store.ts';
export {
  createMemorySteerInbox,
  type SteerInbox,
  type SteerUnit,
  steerStage,
  steerUnitOf,
} from './steer-inbox.ts';
export { sessionToolCoordinator } from './tool-operations.ts';
export { kernelTurnInput, liveSessionOpen } from './turn-input.ts';
