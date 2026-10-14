import { type LabelKey, type LabelOverrides, labelText } from '../guardrails/labels.ts';
import type { TurnStop, TurnStopKind } from '../kernel/types.ts';
import type { TranscriptBlock } from './types.ts';

/** The stops that end a reply short of a whole answer. Each is worded by its `stop.<kind>` label. */
export const WORDED_STOP_KINDS = [
  'cancelled',
  'interrupted',
  'length',
  'filtered',
  'provider_error',
  'stream_incomplete',
  'step_limit',
] as const satisfies readonly TurnStopKind[];

/** One of {@linkcode WORDED_STOP_KINDS}. */
export type WordedStopKind = (typeof WORDED_STOP_KINDS)[number];

const WORDED: ReadonlySet<TurnStopKind> = new Set(WORDED_STOP_KINDS);

function isWorded(kind: TurnStopKind): kind is WordedStopKind {
  return WORDED.has(kind);
}

/**
 * Why a turn ended short, in the person's words: its `stop.<kind>` label, the profile's own when it
 * sets one. `undefined` when the turn ended whole, or when an error in `blocks` (the turn's
 * transcript blocks) already says why.
 */
export function stopText(
  stop: TurnStop | undefined,
  blocks: readonly TranscriptBlock[],
  labels?: LabelOverrides,
): string | undefined {
  if (!stop || !isWorded(stop.kind)) return undefined;
  if (blocks.some((block) => block.kind === 'error')) return undefined;
  const key: LabelKey = `stop.${stop.kind}`;
  return labelText(key, {}, labels);
}
