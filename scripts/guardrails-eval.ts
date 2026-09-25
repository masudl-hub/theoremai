/**
 * Guardrail evaluation against external corpora. Repo-only: the harness fetches
 * third-party datasets and reads a Hugging Face token, so it never ships in the
 * published package.
 *
 * Usage:
 *   deno task guardrails:eval
 *   deno task guardrails:eval -- --cache-dir .guardrail-corpus --limit 50
 *
 * Always exits 0: it measures, it does not gate.
 */
import { formatReport, runGuardrailEval } from '../src/guardrails/eval/mod.ts';

function valueAfterFlag(flag: string): string | undefined {
  const index = Deno.args.indexOf(flag);
  return index === -1 ? undefined : Deno.args[index + 1];
}

const cacheDir = valueAfterFlag('--cache-dir');
const limit = Number(valueAfterFlag('--limit'));
const report = await runGuardrailEval({
  ...(cacheDir ? { cacheDir } : {}),
  ...(Number.isFinite(limit) ? { limit } : {}),
});
console.log(formatReport(report));
