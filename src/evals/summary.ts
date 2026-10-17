import { type GroupSummary, groupSummaries } from './breakdown.ts';
import type { SuiteRun, TurnShape } from './run.ts';
import type { EvalPassRule, EvalResult } from './types.ts';
import type { CaseVerdict, TrialOutcome } from './verdict.ts';

/** One trial in a run summary: its case, index, outcome, trace id, turn shape, error and grader results. */
interface TrialSummary {
  case?: string;
  index: number;
  outcome: TrialOutcome;
  traceId?: string;
  turn?: TurnShape;
  error?: string;
  results: EvalResult[];
}

/** A suite run reduced to what a report shows: the pass rule and verdict, cost, priced and unpriced counts, per-case verdicts, group summaries and trials. */
interface RunSummary {
  suite: string;
  mode: 'live' | 'recorded';
  repeat: number;
  passRule: EvalPassRule;
  passed: boolean;
  stopped?: 'budget';
  costUsd: number;
  unpriced: number;
  priced: number;
  verdicts: CaseVerdict[];
  groups: GroupSummary[];
  trials: TrialSummary[];
  runTraceId?: string;
  warnings: string[];
}

/** Reduces a suite run to a `RunSummary`. */
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
