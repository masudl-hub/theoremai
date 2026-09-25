/**
 * Response identity every provider reports the same way: a `response` event
 * as soon as the wire names the response, and again whenever what it names
 * grows or changes. The runner hands it to the call's trace, so a call that
 * fails or is cut by a guardrail still records which model served it.
 *
 * @module
 */

import type { TurnEvent, TurnResponse } from '../../kernel/types.ts';

/** What the provider knows after a row that named `seen`, and the event to emit when that changed. */
export function foldResponse(
  known: TurnResponse | undefined,
  seen: TurnResponse | undefined,
): { known: TurnResponse | undefined; event?: TurnEvent } {
  if (!seen) return { known };
  const next = { ...known, ...seen };
  if (next.id === known?.id && next.model === known?.model) return { known };
  return { known: next, event: { type: 'response', response: next } };
}
