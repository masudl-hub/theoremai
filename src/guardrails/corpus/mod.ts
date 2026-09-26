/**
 * Adversarial corpus — live attacks, inbound payloads, fuzz runners.
 *
 * Not exported from production `@theoremai/agents/guardrails`; use `@theoremai/agents/guardrails/testing`.
 *
 * @module
 */

/** lexicon-exempt-file: adversarial corpus fixture — not runtime user or model copy (P2) */
export type { CanaryEgressAttack } from './canary-egress-attacks.ts';
export {
  buildCanaryEgressAttacks,
  canaryEgressCatalog,
  FIXED_CANARY,
  FUZZ_SYSTEM,
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
