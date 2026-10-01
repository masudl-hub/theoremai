const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse';
const INTERACTIONS_JSON_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

/** The models a key's project can call; paged with `pageToken`. */
const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const GEMINI_LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export { GEMINI_LIVE_WS_URL, GEMINI_MODELS_URL, INTERACTIONS_JSON_URL, INTERACTIONS_URL };
