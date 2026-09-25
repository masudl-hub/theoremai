/**
 * Guardrail hit helpers — span hits and host/trace projection.
 *
 * A span hit carries `match`, the exact text it caught. Projection strips it unless
 * the host opted into `observability.include.guardrailMatchPreview`.
 *
 * @module
 */

import type { GuardrailEvent, GuardrailHit, Severity } from './types.ts';

/** A span hit, with the exact text it caught from the inspected text. */
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

/**
 * Strip or keep `match` on hits.
 * Default host/trace posture is strip — opt in via profile observability.
 */
function projectGuardrailEvent(event: GuardrailEvent, includeMatch: boolean): GuardrailEvent {
  if (includeMatch) {
    return event;
  }
  return {
    ...event,
    hits: event.hits.map(({ rule, severity, span }) => ({
      rule,
      severity,
      ...(span ? { span } : {}),
    })),
  };
}

export { hitFromSpan, projectGuardrailEvent };
