import type { TurnEvent } from '../../src/kernel/types.ts';

/**
 * The reply as the client assembles it: every `text` event's text, in order.
 * The outbound gate releases text as it clears, so one model chunk can reach
 * the client as more than one event.
 */
export function replyText(events: TurnEvent[]): string {
  return events
    .filter((event) => event.type === 'text')
    .map((event) => event.text ?? '')
    .join('');
}

/** Event types in order, with each run of `text` events counted once. */
export function eventTypesByReply(events: TurnEvent[]): TurnEvent['type'][] {
  return events
    .map((event) => event.type)
    .filter((type, index, types) => type !== 'text' || types[index - 1] !== 'text');
}
