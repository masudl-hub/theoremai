import { projectGuardrailTurnEvent } from '../guardrails/events.ts';
import type { TurnEvent } from '../kernel/types.ts';

/** Options for `forClient`: whether to keep provider-native payloads on evidence events. */
export interface ClientTurnOptions {
  /** Keep provider-native payloads on `evidence` events. Default: false; parsed fields remain. */
  includeEvidenceRaw?: boolean;
}

/** Raw diagnostics ride on error events, an ended session's close, and a tool call's failure. */
function stripErrorInternal(event: TurnEvent): TurnEvent {
  if (
    (event.type !== 'error' && event.type !== 'session' && event.type !== 'tool') ||
    event.errorInternal === undefined
  ) {
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

/** Strips host-only diagnostics, so the copy is safe to forward to browsers or end-user SSE. */
function forClient(event: TurnEvent, options?: ClientTurnOptions): TurnEvent {
  let out = stripGuardrailInternal(stripErrorInternal(event));
  if (!options?.includeEvidenceRaw) {
    out = stripEvidenceRaw(out);
  }
  // invariant: Clients never receive matched substrings, even if the host opted into guardrailMatchPreview.
  out = projectGuardrailTurnEvent(out, false);
  return out;
}

/** `forClient` over a list of events. */
function forClientEvents(events: TurnEvent[], options?: ClientTurnOptions): TurnEvent[] {
  return events.map((event) => forClient(event, options));
}

export { forClient, forClientEvents };
