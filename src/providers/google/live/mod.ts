/**
 * Google Gemini Live provider module.
 *
 * Live execution is session-scoped via `runSession` / `openGoogleLiveSession`.
 * There is no ModelProvider.complete() adapter for geminiLive.
 *
 * @module
 */

export * from './framing.ts';
export {
  type GoogleLiveConnection,
  type OpenLiveWebSocket,
  openGoogleLiveSession,
} from './session.ts';
export {
  attachLiveSessionHandlers,
  createLiveQueue,
  type LiveQueue,
  type LiveTurnPhase,
  performLiveSetup,
  readGeminiLiveErrorMessage,
  readMessageData,
  type SessionQueueItem,
  sendInitialPayloads,
  turnPhaseFromMessage,
} from './stream.ts';
