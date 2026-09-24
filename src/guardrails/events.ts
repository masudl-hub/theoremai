/**
 * Turn-event constructors for guardrail decisions.
 *
 * Keeps `{ type: 'guardrail', guardrail }` shaping in one place so sanitize,
 * egress, tools, network, and live paths cannot drift.
 *
 * @module
 */

import type { TurnEvent } from '../kernel/types.ts';
import { projectGuardrailEvent } from './hits.ts';
import type {
  GuardrailAction,
  GuardrailEvent,
  GuardrailHit,
  GuardrailStage,
  Provenance,
  TrustLevel,
  Verdict,
} from './types.ts';

/** Wrap a GuardrailEvent as a turn stream event. */
function guardrailTurnEvent(guardrail: GuardrailEvent): TurnEvent {
  return { type: 'guardrail', guardrail };
}

/**
 * Build a turn event from a Verdict. `allow` yields nothing (clean = silence).
 * `flag` / `redact` / `block` all emit so hosts and traces can count hits.
 */
function guardrailFromVerdict(
  stage: GuardrailStage,
  trust: TrustLevel,
  verdict: Verdict,
  provenance?: Provenance,
): TurnEvent | undefined {
  if (verdict.action === 'allow') {
    return undefined;
  }
  return guardrailTurnEvent({
    stage,
    trust,
    action: verdict.action,
    hits: verdict.hits,
    ...(provenance ? { provenance } : {}),
    ...(verdict.action === 'block' && verdict.errorInternal
      ? { errorInternal: verdict.errorInternal }
      : {}),
  });
}

/** Build a turn event from a hit list. Empty hits → undefined. */
function guardrailFromHits(
  stage: GuardrailStage,
  trust: TrustLevel,
  hits: GuardrailHit[],
  action: GuardrailAction = 'redact',
  provenance?: Provenance,
): TurnEvent | undefined {
  if (hits.length === 0) {
    return undefined;
  }
  return guardrailTurnEvent({
    stage,
    trust,
    action,
    hits,
    ...(provenance ? { provenance } : {}),
  });
}

/**
 * Project a guardrail turn event for host/trace: strip `hit.match` unless opted in.
 * Non-guardrail events pass through unchanged.
 */
function projectGuardrailTurnEvent(event: TurnEvent, includeMatch: boolean): TurnEvent {
  if (event.type !== 'guardrail' || !event.guardrail) {
    return event;
  }
  return {
    ...event,
    guardrail: projectGuardrailEvent(event.guardrail, includeMatch),
  };
}

export { guardrailFromHits, guardrailFromVerdict, guardrailTurnEvent, projectGuardrailTurnEvent };
