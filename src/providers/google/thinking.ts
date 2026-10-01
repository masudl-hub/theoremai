import { TheoremError } from '../../guardrails/error.ts';
import type { ThinkingLevel } from '../../kernel/schema.ts';
import { GOOGLE_THINKING_LEVELS } from '../../presets/google-limits.ts';

/** Refuses a thinking level Gemini does not take, rather than sending it. */
export function assertGoogleThinkingLevel(level: ThinkingLevel | undefined): void {
  if (level && !(GOOGLE_THINKING_LEVELS as readonly string[]).includes(level)) {
    throw new TheoremError(
      'unsupported',
      `Gemini does not take the '${level}' thinking level (${GOOGLE_THINKING_LEVELS.join(', ')})`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}
