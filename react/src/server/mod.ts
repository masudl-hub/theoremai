/**
 * Server half of `@theoremai/react`: serve one profile to the chat UI.
 *
 * @module
 */

export {
	createTheoremHandler,
	type TheoremHandlerOptions,
	type TheoremRequestContext,
	theoremSessionId,
} from './handler.ts';
export {
	theoremInvokeRequestSchema,
	theoremReplaySchema,
	theoremSteerRequestSchema,
	theoremTurnRequestSchema,
} from '../client/transport.ts';
export type { LiveClientMessage } from '../client/live-messages.ts';
export { checkRequest, parseLiveClientMessage } from './request-check.ts';
export { checkWalkAway, type WalkedAwayCall, walkAway } from './walk-away.ts';
export {
	createMemoryCredentialStore,
	type TheoremCredentialStore,
	type TheoremCredentials,
} from './credential-store.ts';
export {
	createMemorySteerInbox,
	steerUnitOf,
	type SteerInbox,
	steerStage,
	type SteerUnit,
} from './steer-inbox.ts';
export {
	createMemorySessionStore,
	type MemorySessionStoreOptions,
	type PendingToolGate,
	type SettledToolGate,
	type TheoremSessionState,
	type TheoremSessionStore,
} from './session-store.ts';
