import type { TurnEvent } from '../../src/kernel/types.ts';

/**
 * The reply as the client assembles it: every `text` event's text, in order.
 * The outbound gate releases text as it clears, so one model chunk can reach
 * the client as more than one event.
 */
export function replyText(events: readonly TurnEvent[]): string {
  return events.flatMap((event) => (event.type === 'text' ? [event.text] : [])).join('');
}

/** A structured reply's JSON as the client previews it: every `structured_draft` event's text, in order. */
export function structuredDraftText(events: readonly TurnEvent[]): string {
  return events
    .flatMap((event) => (event.type === 'structured_draft' ? [event.text] : []))
    .join('');
}

/** Event types in order, with each run of `text` or `structured_draft` events counted once. */
export function eventTypesByReply(events: TurnEvent[]): TurnEvent['type'][] {
  return events
    .map((event) => event.type)
    .filter(
      (type, index, types) =>
        (type !== 'text' && type !== 'structured_draft') || types[index - 1] !== type,
    );
}
