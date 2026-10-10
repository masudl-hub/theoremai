/** Provider-neutral live tracing and tool read-back helpers.
 * @module
 */
import type { TurnHistoryMessage } from '../kernel/types.ts';

export function liveSentInput(row: Record<string, unknown>): TurnHistoryMessage[] {
  return Array.isArray(row.input) ? (row.input as TurnHistoryMessage[]) : [];
}
export function liveToolReadBack(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}
