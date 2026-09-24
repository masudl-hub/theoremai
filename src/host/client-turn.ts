/**
 * Strip host-only diagnostics from turn events before client-facing transports.
 *
 * @module
 */

import { projectGuardrailTurnEvent } from '../guardrails/events.ts';
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

function stripGuardrailInternal(event: TurnEvent): TurnEvent {
  if (event.type !== 'guardrail' || !event.guardrail?.errorInternal) {
    return event;
  }
  const { errorInternal: _internal, ...guardrail } = event.guardrail;
  return { ...event, guardrail };
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
  let out = stripGuardrailInternal(stripErrorInternal(event));
  if (!options?.includeEvidenceRaw) {
    out = stripEvidenceRaw(out);
  }
  // Clients never receive matched substrings — even if the host opted into
  // guardrailMatchPreview for server logs / JSONL.
  out = projectGuardrailTurnEvent(out, false);
  return out;
}

/** Map {@link forClient} over a batch (e.g. Live relay or HTTP stream flush). */
function forClientEvents(events: TurnEvent[], options?: ClientTurnOptions): TurnEvent[] {
  return events.map((event) => forClient(event, options));
}

export { forClient, forClientEvents };
