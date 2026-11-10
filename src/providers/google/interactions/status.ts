import type { TurnStop } from '../../../kernel/turn-events.ts';

/** The stop an Interactions `status` reports when the call ends. */
export function turnStopFromInteractionStatus(status: string | null | undefined): TurnStop {
  const s = (status || '').toLowerCase();
  const native = status || undefined;
  switch (s) {
    case 'completed':
      return { kind: 'completed', native };
    case 'incomplete':
    case 'budget_exceeded':
      return { kind: 'length', native };
    case 'requires_action':
      return { kind: 'tool', native };
    case 'cancelled':
      return { kind: 'cancelled', native };
    case 'failed':
      return { kind: 'provider_error', native };
    case 'in_progress':
    case 'queued':
      return { kind: 'stream_incomplete', native };
    default:
      return { kind: 'stream_incomplete', native };
  }
}
