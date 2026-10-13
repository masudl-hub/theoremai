import { type ErrorKind, toErrorEvent, withPublicLabels } from '../guardrails/error.ts';
import { projectGuardrailTurnEvent } from '../guardrails/events.ts';
import type { LabelOverrides } from '../guardrails/labels.ts';
import type { TurnEvent } from '../kernel/types.ts';

/** Options for `forClient` and `clientError`: who reads the copy, and whether evidence keeps its provider-native payload. */
export interface ClientTurnOptions {
  /** Keep provider-native payloads on `evidence` events. Default: false; parsed fields remain. */
  includeEvidenceRaw?: boolean;
  /**
   * Who reads the copy. A `'visitor'` (the default) reads the profile's wording, and every
   * builder-only diagnostic is stripped. A `'builder'` is whoever builds the app, on their own
   * machine and keys, as in a local development tool: a failure reads its raw diagnostic in place
   * of the profile's wording, and builder-only diagnostics stay. Never for a page visitors reach.
   */
  reader?: 'visitor' | 'builder';
}

/** For the builder, a failure's wording is its raw diagnostic. */
function builderWording(event: TurnEvent): TurnEvent {
  if (event.type !== 'error' || event.errorInternal === undefined) return event;
  const { errorInternal, ...rest } = event;
  return { ...rest, error: errorInternal };
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

/**
 * The copy of an event its reader may have. For a visitor (the default) host-only diagnostics are
 * stripped, so the copy is safe to forward to browsers or end-user SSE.
 */
function forClient(event: TurnEvent, options?: ClientTurnOptions): TurnEvent {
  let out =
    options?.reader === 'builder'
      ? builderWording(event)
      : stripGuardrailInternal(stripErrorInternal(event));
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

/** A failure's wording and kind as a client reads them: the body of an error reply or line. */
type ClientError = { error: string; errorKind: ErrorKind };

/**
 * A caught failure as its reader may have it, by the same rule as `forClient`: the profile's
 * wording (pass its `labels`) for a visitor, the raw diagnostic for a builder.
 */
function clientError(
  err: unknown,
  labels?: LabelOverrides,
  options?: ClientTurnOptions,
): ClientError {
  const event = forClient(withPublicLabels(toErrorEvent(err), labels), options);
  // why: An error event stays one through `withPublicLabels` and `forClient`, worded by the first.
  const { error = '', errorKind } = event as Extract<TurnEvent, { type: 'error' }>;
  return { error, errorKind };
}

export type { ClientError };
export { clientError, forClient, forClientEvents };
