/**
 * A suite run as one JSON document: what `agents eval --json` prints for CI.
 * Verdicts and results keep their shapes; trials lose their records, which
 * the sink already has.
 *
 * @module
 */

import type { SuiteRun } from './run.ts';
import type { EvalResult } from './types.ts';
import type { CaseVerdict, TrialOutcome } from './verdict.ts';

interface TrialSummary {
  case?: string;
  index: number;
  outcome: TrialOutcome;
  traceId?: string;
  error?: string;
  results: EvalResult[];
}

interface RunSummary {
  suite: string;
  mode: 'live' | 'recorded';
  repeat: number;
  passed: boolean;
  stopped?: 'budget';
  /** Agent and judge spend together. */
  costUsd: number;
  verdicts: CaseVerdict[];
  /** Every trial, cased then caseless. */
  trials: TrialSummary[];
  runTraceId?: string;
  warnings: string[];
}

/** The run as its summary. */
function summarizeRun(run: SuiteRun): RunSummary {
  const trials = [...run.trials, ...run.caseless].map((report) => ({
    ...(report.case ? { case: report.case.id } : {}),
    index: report.index,
    outcome: report.outcome,
    ...(report.traceId ? { traceId: report.traceId } : {}),
    ...(report.error ? { error: report.error } : {}),
    results: report.results,
  }));
  const runTraceId = run.run.spans[0]?.traceId;
  return {
    suite: run.suite,
    mode: run.mode,
    repeat: run.repeat,
    passed: run.passed,
    ...(run.stopped ? { stopped: run.stopped } : {}),
    costUsd: run.costUsd,
    verdicts: run.verdicts,
    trials,
    ...(runTraceId ? { runTraceId } : {}),
    warnings: run.warnings,
  };
}

export type { RunSummary, TrialSummary };
export { summarizeRun };
