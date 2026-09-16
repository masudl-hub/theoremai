/**
 * Guardrail hit helpers — match previews and host/trace projection.
 *
 * Detectors may attach `match` (the exact substring). Projection strips it unless
 * the host opted into `observability.include.guardrailMatchPreview`.
 *
 * @module
 */

import type { GuardrailEvent, GuardrailHit, Severity } from './types.ts';

/** Cap for `GuardrailHit.match` so PEM / long blobs do not explode logs. */
const GUARDRAIL_MATCH_PREVIEW_MAX = 512;

/** Slice + cap the matched substring for debugging. */
function matchPreview(text: string, start: number, end: number): string {
  const raw = text.slice(start, end);
  if (raw.length <= GUARDRAIL_MATCH_PREVIEW_MAX) {
    return raw;
  }
  return `${raw.slice(0, GUARDRAIL_MATCH_PREVIEW_MAX)}…`;
}

/** Build a span hit with an optional match preview from the inspected text. */
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
    match: matchPreview(text, span.start, span.end),
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

export { GUARDRAIL_MATCH_PREVIEW_MAX, hitFromSpan, matchPreview, projectGuardrailEvent };
