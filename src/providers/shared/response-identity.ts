import type { ProviderEvent, TurnResponse } from '../../kernel/types.ts';

/**
 * Emits as soon as the wire names the response and again whenever that changes, so a
 * call that fails or is cut by a guardrail still records which model served it.
 */
export function foldResponse(
  known: TurnResponse | undefined,
  seen: TurnResponse | undefined,
): { known: TurnResponse | undefined; event?: Extract<ProviderEvent, { type: 'response' }> } {
  if (!seen) return { known };
  const next = { ...known, ...seen };
  if (next.id === known?.id && next.model === known?.model) return { known };
  return { known: next, event: { type: 'response', response: next } };
}
