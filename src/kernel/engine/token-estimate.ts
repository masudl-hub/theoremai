/**
 * Text counts use a characters / 4 heuristic for all model families. Media is never estimated: a
 * media part is reported as `unknownMedia`, and the upstream's own count is used when it gives one.
 */

import { historyMessageParts } from '../interaction-parts.ts';
import type { InteractionPart, TurnHistoryMessage } from '../types.ts';

/** Text estimation method; retained under this name for API compatibility. */
export const TOKEN_TEXT_ENCODING = 'chars/4';

/** A token count and the number of media parts left out of it. */
export interface TokenCount {
  tokens: number;
  /** Media parts left out of `tokens` because their count is unknown. */
  unknownMedia: number;
}

/** Text counting is synchronous; anything with media is not. */
export interface TokenEstimator {
  /** Approximate tokens: UTF-16 code units divided by four, rounded up. */
  text: (text: string) => number;
  parts: (parts: InteractionPart[]) => TokenCount;
  /** Content, parts, and tool-call arguments across history messages. */
  messages: (messages: TurnHistoryMessage[]) => TokenCount;
}

function buildEstimator(): TokenEstimator {
  const text = (value: string): number => Math.ceil(value.length / 4);
  const parts: TokenEstimator['parts'] = (list) => {
    const count: TokenCount = { tokens: 0, unknownMedia: 0 };
    for (const part of list) {
      if (part.type === 'text') {
        count.tokens += text(part.text);
        continue;
      }
      count.unknownMedia += 1;
    }
    return count;
  };
  const messages: TokenEstimator['messages'] = (list) => {
    const count: TokenCount = { tokens: 0, unknownMedia: 0 };
    for (const msg of list) {
      const fromParts = parts(historyMessageParts(msg));
      count.tokens += fromParts.tokens;
      count.unknownMedia += fromParts.unknownMedia;
      for (const tc of msg.tool_calls ?? []) {
        count.tokens += text(tc.function.name) + text(tc.function.arguments);
      }
    }
    return count;
  };
  return { text, parts, messages };
}

/** Returns the heuristic estimator; async for compatibility with existing callers. */
export function loadTokenEstimator(): Promise<TokenEstimator> {
  return Promise.resolve(buildEstimator());
}
