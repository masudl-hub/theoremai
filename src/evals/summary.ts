/**
 * A suite run as one JSON document: what `agents eval --json` prints for CI.
 * Verdicts and results keep their shapes; trials lose their records, which
 * the sink already has.
 *
 * @module
 */

import { type GroupSummary, groupSummaries } from './breakdown.ts';
import type { SuiteRun, TurnShape } from './run.ts';
import type { EvalPassRule, EvalResult } from './types.ts';
import type { CaseVerdict, TrialOutcome } from './verdict.ts';

interface TrialSummary {
  case?: string;
  index: number;
  outcome: TrialOutcome;
  traceId?: string;
  turn?: TurnShape;
  error?: string;
  results: EvalResult[];
}

interface RunSummary {
  suite: string;
  mode: 'live' | 'recorded';
  repeat: number;
  passRule: EvalPassRule;
  passed: boolean;
  stopped?: 'budget';
  /** Agent and judge spend together, over the calls that reported a cost. */
  costUsd: number;
  /** Agent turns and judge calls whose cost went unreported, in whole or part. */
  unpriced: number;
  /** Agent turns and judge calls that reported a cost, a zero included. */
  priced: number;
  verdicts: CaseVerdict[];
  /** Every cased trial, then each tag's. */
  groups: GroupSummary[];
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
    ...(report.turn ? { turn: report.turn } : {}),
    ...(report.error ? { error: report.error } : {}),
    results: report.results,
  }));
  const runTraceId = run.run.spans[0]?.traceId;
  return {
    suite: run.suite,
    mode: run.mode,
    repeat: run.repeat,
    passRule: run.passRule,
    passed: run.passed,
    ...(run.stopped ? { stopped: run.stopped } : {}),
    costUsd: run.costUsd,
    unpriced: run.unpriced,
    priced: run.priced,
    verdicts: run.verdicts,
    groups: groupSummaries(run),
    trials,
    ...(runTraceId ? { runTraceId } : {}),
    warnings: run.warnings,
  };
}

export type { RunSummary, TrialSummary };
export { summarizeRun };
