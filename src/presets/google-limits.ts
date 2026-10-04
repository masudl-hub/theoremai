import { TheoremError } from '../guardrails/theorem-error.ts';

/** The thinking levels Gemini's `thinkingLevel` takes; OpenRouter models take them all. */
const GOOGLE_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;

/** The audio format Gemini speech returns (PCM, wrapped as WAV); OpenRouter speech also takes `mp3`. */
const GOOGLE_SPEECH_FORMATS = ['pcm'] as const;

type GoogleThinkingLevel = (typeof GOOGLE_THINKING_LEVELS)[number];

/**
 * A `geminiInteractions` or `geminiLive` binding's `efforts`, typed to the levels Gemini takes.
 * The runtime check refuses an untyped host's level when the binding is built, not when a turn runs.
 */
function googleEfforts<Efforts extends Record<string, GoogleThinkingLevel>>(
  efforts: Efforts,
): Efforts {
  for (const [alias, level] of Object.entries(efforts)) {
    if (!(GOOGLE_THINKING_LEVELS as readonly string[]).includes(level)) {
      throw new TheoremError(
        'config',
        `Effort '${alias}': Gemini does not take '${level}' (${GOOGLE_THINKING_LEVELS.join(', ')})`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
  return efforts;
}

export type { GoogleThinkingLevel };
export { GOOGLE_SPEECH_FORMATS, GOOGLE_THINKING_LEVELS, googleEfforts };
