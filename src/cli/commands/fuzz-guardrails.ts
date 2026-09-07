/**
 * Adversarial inbound guardrail fuzzer (CLI entry).
 *
 * @module
 */

import { runInboundGuardrailFuzz } from '../../guardrails/corpus/fuzz-inbound.ts';

/** Run inbound fuzz; returns true when no expected catches are missed. */
export function fuzzGuardrailsCommand(): boolean {
  return runInboundGuardrailFuzz();
}
