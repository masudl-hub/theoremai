/**
 * Google usage lists shared by Interactions and Live, in the spellings the
 * wire sends (probed 23/09/2026):
 *
 * - Interactions: `input_tokens_by_modality` / `output_tokens_by_modality`,
 *   `[{ modality: 'text', tokens }]`; `grounding_tool_count`,
 *   `[{ type, count, search_query_count }]`.
 * - Live: `promptTokensDetails` / `responseTokensDetails`,
 *   `[{ modality: 'TEXT', tokenCount }]`.
 *
 * Both list only some modalities (Live listed 126 text of 144 prompt tokens;
 * an image reply listed 1,120 image of 1,378 output tokens), so the shares
 * are kept as reported and never filled to the total.
 *
 * @module
 */

import { asRecord } from '../../kernel/engine/record.ts';
import { usageCount } from '../../kernel/engine/usage.ts';
import type { TurnGroundingCount } from '../../kernel/types.ts';

/** A modality list → `{ modality: tokens }` (lower-case), or `undefined` when it reports nothing. */
export function modalityCounts(
  raw: unknown,
  countKey: 'tokens' | 'tokenCount',
): Record<string, number> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const counts: Record<string, number> = {};
  for (const entry of raw) {
    const rec = asRecord(entry);
    const count = usageCount(rec?.[countKey]);
    if (typeof rec?.modality === 'string' && count !== undefined) {
      const modality = rec.modality.toLowerCase();
      counts[modality] = (counts[modality] ?? 0) + count;
    }
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

/** Input and output modality lists → `TurnTokens.byModality`, or `undefined`. */
export function byModality(
  input: Record<string, number> | undefined,
  output: Record<string, number> | undefined,
): { input?: Record<string, number>; output?: Record<string, number> } | undefined {
  if (!input && !output) return undefined;
  return { ...(input ? { input } : {}), ...(output ? { output } : {}) };
}

/** Interactions `grounding_tool_count` → `TurnTokens.grounding`, or `undefined`. */
export function groundingCounts(raw: unknown): TurnGroundingCount[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const counts = raw.flatMap((entry): TurnGroundingCount[] => {
    const rec = asRecord(entry);
    const count = usageCount(rec?.count);
    if (typeof rec?.type !== 'string' || count === undefined) return [];
    const queries = usageCount(rec.search_query_count);
    return [
      { type: rec.type, count, ...(queries === undefined ? {} : { searchQueryCount: queries }) },
    ];
  });
  return counts.length > 0 ? counts : undefined;
}
