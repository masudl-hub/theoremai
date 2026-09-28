/**
 * Gemini Live socket transport, opened by `runSession`; it applies no guardrails of its own.
 *
 * @module
 */

export {
  type GoogleLiveConnection,
  type OpenLiveWebSocket,
  openGoogleLiveSession,
} from './session.ts';
