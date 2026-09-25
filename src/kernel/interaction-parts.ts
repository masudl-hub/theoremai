/**
 * InteractionPart wire helpers shared by kernel history + provider adapters.
 *
 * @module
 */

import type { InteractionMediaRefPart, InteractionPart, TurnHistoryMessage } from './types.ts';

/**
 * Map an InteractionPart to the Google Interactions / function_result wire shape.
 * Reference parts emit `{ type, mimeType, uri }`; `toGoogleValue` snake-cases
 * `mimeType` → `mime_type`, which is the documented Interactions file input.
 */
export function wireInteractionPart(part: InteractionPart): Record<string, string> {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  if ('uri' in part) {
    return { type: part.type, mimeType: part.mimeType, uri: part.uri };
  }
  return { type: part.type, mimeType: part.mimeType, data: part.data };
}

/** True when the part carries a provider file reference instead of inline bytes. */
export function isMediaRefPart(part: InteractionPart): part is InteractionMediaRefPart {
  return part.type !== 'text' && 'uri' in part;
}

/**
 * Everything a history message says, in the one order every provider adapter
 * sends it: `content` first as a text part (when non-empty), then `parts`.
 * Neither field replaces the other.
 */
export function historyMessageParts(msg: TurnHistoryMessage): InteractionPart[] {
  const parts = msg.parts ?? [];
  return msg.content ? [{ type: 'text', text: msg.content }, ...parts] : [...parts];
}
