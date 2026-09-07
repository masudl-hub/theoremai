/**
 * Adversarial corpus — live attacks, inbound payloads, fuzz runners.
 *
 * Not exported from production `theorum/guardrails`; use `theorum/guardrails/testing`.
 *
 * @module
 */

export type { CanaryEgressAttack } from './canary-egress-attacks.ts';
export {
  buildCanaryEgressAttacks,
  canaryEgressCatalog,
  FIXED_CANARY,
} from './canary-egress-attacks.ts';
export { runInboundGuardrailFuzz } from './fuzz-inbound.ts';
export { inboundFuzzPayloads, inboundPayloadByName } from './inbound-payloads.ts';
export { buildLiveAttacks, filterLiveAttacks, summarizeAttackBank } from './live-attacks.ts';
export type {
  CanaryEgressCatalogEntry,
  InboundFuzzPayload,
  InboundFuzzResult,
  LiveAttack,
} from './types.ts';
