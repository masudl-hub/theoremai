/** The thinking levels Gemini's `thinkingLevel` takes; OpenRouter models take them all. */
const GOOGLE_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;

/** The audio format Gemini speech returns (PCM, wrapped as WAV); OpenRouter speech also takes `mp3`. */
const GOOGLE_SPEECH_FORMATS = ['pcm'] as const;

export { GOOGLE_SPEECH_FORMATS, GOOGLE_THINKING_LEVELS };
