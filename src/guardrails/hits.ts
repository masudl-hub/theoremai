import type { GuardrailEvent, GuardrailHit, Severity } from './types.ts';

function hitFromSpan(
  text: string,
  span: { start: number; end: number },
  rule: string,
  severity: Severity,
): GuardrailHit {
  return {
    rule,
    severity,
    span: { start: span.start, end: span.end },
    match: text.slice(span.start, span.end),
  };
}

/** `match` is the caught text itself, so hosts and traces get it only via `observability.include.guardrailMatchPreview`. */
function projectGuardrailEvent(event: GuardrailEvent, includeMatch: boolean): GuardrailEvent {
  if (includeMatch) {
    return event;
  }
  return {
    ...event,
    hits: event.hits.map(({ match: _match, ...hit }) => hit),
  };
}

export { hitFromSpan, projectGuardrailEvent };
