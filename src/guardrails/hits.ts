import { DETECT_RULES } from './rules.ts';
import type { GuardrailEvent, GuardrailHit, Severity } from './types.ts';

/** A canary leak. Never carries the live token, only a placeholder. */
const CANARY_HIT: GuardrailHit = {
  rule: DETECT_RULES.canary_leak,
  severity: 'high',
  match: '[canary]',
};

/** A prompt leak. Never carries the words: they are the private system instruction's. */
const PROMPT_ECHO_HIT: GuardrailHit = { rule: DETECT_RULES.prompt_leak, severity: 'high' };

/** A guardrail hit for a span of the text, with the matched text sliced from it. */
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

export { CANARY_HIT, hitFromSpan, PROMPT_ECHO_HIT, projectGuardrailEvent };
