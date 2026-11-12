/**
 * Late results a turn reads when it opens, the way a host gives the results that ended between
 * two turns.
 *
 * @module
 */

import type { ToolOperationOutcome } from '../../src/kernel/tools/operation.ts';
import type { LateResultsSource } from '../../src/kernel/types.ts';

/** A source that gives `outcomes` when the turn opens and nothing after. */
export function atOpen(outcomes: readonly ToolOperationOutcome[]): LateResultsSource {
  return ({ stage }) => (stage === 'pre_turn' ? outcomes : []);
}
