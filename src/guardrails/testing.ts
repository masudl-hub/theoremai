/**
 * Adversarial corpus, fuzz runners, and live attack builders, kept off the production guardrails entry.
 *
 * @module
 */

/** labels-exempt-file: adversarial harness helpers — not runtime user or model copy (P2) */
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
export {
  TEST_AWS_KEY,
  TEST_GITHUB_PAT,
  TEST_GOOGLE_KEY,
  TEST_OPENAI_KEY,
  TEST_PEM,
  TEST_SLACK,
  TEST_VISA,
} from './corpus/secrets.ts';
export { INJ_IGNORE, INJ_IGNORE_REVEAL, injHexSpaced } from './corpus/strings.ts';
