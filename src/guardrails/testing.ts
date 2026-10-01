/**
 * Adversarial corpus, fuzz runners and live attack builders, kept off the production guardrails entry.
 *
 * @module
 */

/** lexicon-exempt-file: adversarial harness helpers — not runtime user or model copy (P2) */
export type {
  CanaryEgressAttack,
  CanaryEgressCatalogEntry,
  InboundFuzzPayload,
  InboundFuzzResult,
  LiveAttack,
} from './corpus/mod.ts';
export {
  buildCanaryEgressAttacks,
  buildLiveAttacks,
  canaryEgressCatalog,
  FIXED_CANARY,
  FUZZ_SYSTEM,
  filterLiveAttacks,
  inboundFuzzPayloads,
  inboundPayloadByName,
  runInboundGuardrailFuzz,
  summarizeAttackBank,
} from './corpus/mod.ts';
