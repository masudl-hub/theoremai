/**
 * Strip host-only diagnostics from turn events before client-facing transports.
 *
 * @module
 */

import type { TurnEvent } from '../kernel/types.ts';

/** Options for {@link forClient} / {@link forClientEvents}. */
export interface ClientTurnOptions {
  /**
   * Keep provider-native step payloads on `evidence` events.
   * Default `false` — parsed fields (`kind`, `code`, `result`, citations) remain.
   */
  includeEvidenceRaw?: boolean;
}

function stripErrorInternal(event: TurnEvent): TurnEvent {
  if (event.type !== 'error' || !event.errorInternal) {
    return event;
  }
  const { errorInternal: _internal, ...rest } = event;
  return rest;
}

function stripEvidenceRaw(event: TurnEvent): TurnEvent {
  if (event.type !== 'evidence' || !event.evidence?.raw) {
    return event;
  }
  const { raw: _raw, ...evidence } = event.evidence;
  return { ...event, evidence };
}

/** Return a copy of one turn event safe to forward to browsers or end-user SSE. */
function forClient(event: TurnEvent, options?: ClientTurnOptions): TurnEvent {
  let out = stripErrorInternal(event);
  if (!options?.includeEvidenceRaw) {
    out = stripEvidenceRaw(out);
  }
  return out;
}

/** Map {@link forClient} over a batch (e.g. Live relay or HTTP stream flush). */
function forClientEvents(events: TurnEvent[], options?: ClientTurnOptions): TurnEvent[] {
  return events.map((event) => forClient(event, options));
}

export { forClient, forClientEvents };
