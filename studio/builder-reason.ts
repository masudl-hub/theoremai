import { describeError } from '../src/guardrails/error.ts';
import { DecisionError } from '../src/kernel/engine/decision.ts';

/**
 * Why a run failed, for the builder. The studio runs on the builder's own machine and keys, so
 * a failure says what happened (no key in a slot, a rejected key) instead of the visitor wording.
 * A decision's failure is normalized, so the reason is what the provider path threw.
 */
export function builderReason(err: unknown): string {
  return describeError(err instanceof DecisionError && err.cause !== undefined ? err.cause : err);
}
