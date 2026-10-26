/**
 * Cookbook opening exchanges: Studio `.trace.json` recordings projected with the same helpers
 * Replay exchange and Continue live use. One truth — the file is the exchange.
 */
import type { TraceRecord } from '@theoremjs/agents';
import type { TranscriptBlock } from '@theoremjs/agents/interface';
import { openingFromRecords, parseTraceRecords } from '../replay.ts';
import type { CookbookId } from './catalog.ts';
import researchTrace from './fixtures/research.trace.json' with { type: 'json' };

const OPENINGS: Partial<Record<CookbookId, unknown>> = {
  research: researchTrace,
};

/** The cookbook's recorded trace records, when it has a `.trace.json`. */
export function cookbookTraceRecords(id: CookbookId): TraceRecord[] | undefined {
  const value = OPENINGS[id];
  return value === undefined ? undefined : parseTraceRecords(value);
}

/**
 * The conversation a cookbook opens as history, from its recorded `.trace.json`. Undefined when
 * the cookbook has no recording yet.
 */
export function cookbookOpening(id: CookbookId): TranscriptBlock[] | undefined {
  const records = cookbookTraceRecords(id);
  return records === undefined ? undefined : openingFromRecords(records);
}
