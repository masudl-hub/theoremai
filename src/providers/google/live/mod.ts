/**
 * Google Gemini Live transport.
 *
 * Live execution is session-scoped: `runSession` resolves the profile, applies
 * inbound prep and the outbound gate, and opens the socket through
 * `openGoogleLiveSession`. Like `createProvider` on the turn side, the
 * transport applies no guardrails of its own. There is no
 * `ModelProvider.complete()` adapter for geminiLive.
 *
 * @module
 */

export {
  type GoogleLiveConnection,
  type OpenLiveWebSocket,
  openGoogleLiveSession,
} from './session.ts';
