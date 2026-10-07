/**
 * Server half of `@theoremjs/react`: serve one profile to the chat UI, a
 * decision profile to the decision UI, or a host profile's tools to the host UI.
 *
 * @module
 */

export { theoremHostCallRequestSchema } from '../client/host-transport.ts';
export type { LiveClientMessage, LiveOpenMessage } from '../client/live-messages.ts';
export {
  theoremInvokeRequestSchema,
  theoremReplaySchema,
  theoremSteerRequestSchema,
  theoremTurnRequestSchema,
} from '../client/transport.ts';
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
  theoremSessionId,
} from './handler.ts';
export { checkRequest, parseLiveClientMessage, parseLiveOpenMessage } from './request-check.ts';
export { liveSessionOpen } from './turn-input.ts';
export {
  createMemorySessionStore,
  type MemorySessionStoreOptions,
  type PendingToolGate,
  type SettledToolGate,
  type TheoremSessionState,
  type TheoremSessionStore,
} from './session-store.ts';
export {
  createMemorySteerInbox,
  type SteerInbox,
  type SteerUnit,
  steerStage,
  steerUnitOf,
} from './steer-inbox.ts';
export { checkWalkAway, type WalkedAwayCall, walkAway } from './walk-away.ts';
