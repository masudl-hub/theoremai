/**
 * Guardrails testing surface — adversarial corpus, fuzz runners, live attack builders.
 *
 * Import via `@theoremai/agents/guardrails/testing` (not published on the production guardrails entry).
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
  filterLiveAttacks,
  inboundFuzzPayloads,
  inboundPayloadByName,
  runInboundGuardrailFuzz,
  summarizeAttackBank,
} from './corpus/mod.ts';
export type { CorpusSample, CorpusSource } from './eval/corpus.ts';
export { createCorpusCache, parseLabelledCsv, recordsFromYaml, SOURCES } from './eval/corpus.ts';
export type { EvalOptions, EvalReport } from './eval/mod.ts';
export { DETECTORS, formatReport, runGuardrailEval } from './eval/mod.ts';
export type { DetectorScore, EvalDetector } from './eval/score.ts';
export { formatScores, scoreAll, scoreDetector } from './eval/score.ts';
