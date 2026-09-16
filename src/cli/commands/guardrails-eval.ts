/**
 * Guardrail evaluation against external corpora (CLI entry).
 *
 * Fetches on demand and caches locally; nothing is vendored into the repo or the
 * published package.
 *
 * @module
 */

import { formatReport, runGuardrailEval } from '../../guardrails/eval/mod.ts';

export interface GuardrailEvalOptions {
  cacheDir?: string;
  limit?: number;
}

/** Run the evaluation and print the report. Always returns true: it measures, it does not gate. */
export async function guardrailsEvalCommand(options: GuardrailEvalOptions = {}): Promise<boolean> {
  const report = await runGuardrailEval(options);
  console.log(formatReport(report));
  return true;
}
