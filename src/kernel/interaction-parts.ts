/**
 * InteractionPart wire helpers shared by kernel history + provider adapters.
 *
 * @module
 */

import type { InteractionMediaRefPart, InteractionPart } from './types.ts';

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
