/** The thinking levels Gemini's `thinkingLevel` takes; OpenRouter models take them all. */
export const GOOGLE_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;

/** The audio format Gemini speech returns (PCM, wrapped as WAV); OpenRouter speech also takes `mp3`. */
export const GOOGLE_SPEECH_FORMATS = ['pcm'] as const;
