/**
 * Structured output parse shared by every provider that asks for JSON text.
 *
 * @module
 */

import { TheoremError, toErrorEvent } from '../../guardrails/error.ts';
import type { TurnEvent } from '../../kernel/types.ts';

/** Model text as a `structured` event. Invalid JSON is a `bad_response` error — never a silent skip. */
function structuredEvent(text: string): TurnEvent {
  try {
    return { type: 'structured', structured: JSON.parse(text) };
  } catch (cause) {
    return toErrorEvent(
      new TheoremError('bad_response', 'structured output was not valid JSON', { cause }), // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

export { structuredEvent };
