import type { TurnEvent, TurnEventOf } from '../kernel/turn-events.ts';
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

function guardrailTurnEvent(guardrail: GuardrailEvent): TurnEventOf<'guardrail'> {
  return { type: 'guardrail', guardrail };
}

/** `allow` yields nothing; `flag`, `redact` and `block` all emit so hosts and traces can count hits. */
function guardrailFromVerdict(
  stage: GuardrailStage,
  trust: TrustLevel,
  verdict: Verdict,
  provenance?: Provenance,
): TurnEventOf<'guardrail'> | undefined {
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

function guardrailFromHits(
  stage: GuardrailStage,
  trust: TrustLevel,
  hits: GuardrailHit[],
  action: GuardrailAction = 'redact',
  provenance?: Provenance,
): TurnEventOf<'guardrail'> | undefined {
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

function projectGuardrailTurnEvent(
  event: TurnEventOf<'guardrail'>,
  includeMatch: boolean,
): TurnEventOf<'guardrail'>;
function projectGuardrailTurnEvent(event: TurnEvent, includeMatch: boolean): TurnEvent;
function projectGuardrailTurnEvent(event: TurnEvent, includeMatch: boolean): TurnEvent {
  if (event.type !== 'guardrail') {
    return event;
  }
  return {
    ...event,
    guardrail: projectGuardrailEvent(event.guardrail, includeMatch),
  };
}

export { guardrailFromHits, guardrailFromVerdict, guardrailTurnEvent, projectGuardrailTurnEvent };
