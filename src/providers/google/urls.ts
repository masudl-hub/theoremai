/** Google Interactions API endpoints. */
const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse';
const INTERACTIONS_JSON_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

/** Google Gemini Live WebSocket endpoint. */
const GEMINI_LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export { GEMINI_LIVE_WS_URL, INTERACTIONS_JSON_URL, INTERACTIONS_URL };
