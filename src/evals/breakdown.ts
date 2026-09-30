/**
 * A run by group: every cased trial together, then each tag's trials. What a
 * dataset run reports: how often the agent was right, how consistently, how
 * long it took and how many times it looped, so "fast on houseplants, lost on
 * succulents" shows.
 *
 * @module
 */

import type { SuiteRun, TrialReport } from './run.ts';
import type { CaseVerdict } from './verdict.ts';

/** Nearest-rank percentiles, so each is a value some trial had. */
interface Spread {
  median: number;
  p90: number;
}

/** One group's trials: `all`, or those of cases carrying a tag. */
interface GroupSummary {
  /** `all`, or the tag. */
  group: string;
  cases: number;
  /** Cases whose trials met the suite's pass rule: pass^k under the default `all`. */
  casesPassed: number;
  /** Cases too few of whose trials escaped error to apply the rule; out of the pass rate. */
  casesUndecided: number;
  trials: number;
  trialsPassed: number;
  /** Trials that could not be graded (a provider error, a failed judge); out of the pass rate. */
  trialsErrored: number;
  /** The `answer` grader's labels over the trials, when the suite grades answers; `none` had no label (the turn errored). */
  answers?: { accepted: number; partial: number; wrong: number; none: number };
  /** How the trials that produced a trace stopped, by `theorem.stop.kind` (`unrecorded` when the root has none). */
  stops: Record<string, number>;
  /** Over the trials that produced a trace. */
  durationMs?: Spread;
  modelCalls?: Spread;
  toolCalls?: Spread;
}

const MEDIAN = 0.5;
const P90 = 0.9;

function rank(sorted: readonly number[], quantile: number): number {
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)] ?? 0;
}

function spread(values: number[]): Spread | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  return { median: rank(sorted, MEDIAN), p90: rank(sorted, P90) };
}

function answerLabel(report: TrialReport): string | undefined {
  return report.results.find((result) => result.name === 'answer')?.score?.label;
}

function groupOf(
  group: string,
  verdicts: readonly CaseVerdict[],
  trials: readonly TrialReport[],
  gradesAnswers: boolean,
): GroupSummary {
  const turns = trials.flatMap((report) => report.turn ?? []);
  const of = (key: 'durationMs' | 'modelCalls' | 'toolCalls') =>
    spread(turns.map((turn) => turn[key]));
  const labels = trials.map(answerLabel);
  const count = (label: string | undefined) => labels.filter((each) => each === label).length;
  const stops: Record<string, number> = {};
  for (const turn of turns) {
    const stop = turn.stop ?? 'unrecorded';
    stops[stop] = (stops[stop] ?? 0) + 1;
  }
  const durationMs = of('durationMs');
  const modelCalls = of('modelCalls');
  const toolCalls = of('toolCalls');
  return {
    group,
    cases: verdicts.length,
    casesPassed: verdicts.filter((verdict) => verdict.passed).length,
    casesUndecided: verdicts.filter((verdict) => !verdict.decided).length,
    trials: trials.length,
    trialsPassed: trials.filter((report) => report.outcome === 'passed').length,
    trialsErrored: trials.filter((report) => report.outcome === 'errored').length,
    ...(gradesAnswers
      ? {
          answers: {
            accepted: count('accepted'),
            partial: count('partial'),
            wrong: count('wrong'),
            none: count(undefined),
          },
        }
      : {}),
    stops,
    ...(durationMs ? { durationMs } : {}),
    ...(modelCalls ? { modelCalls } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

/** `all` first, then each tag in name order. Caseless trials belong to no group. */
function groupSummaries(run: Pick<SuiteRun, 'trials' | 'verdicts'>): GroupSummary[] {
  const gradesAnswers = run.trials.some((report) =>
    report.results.some((result) => result.name === 'answer'),
  );
  const tags = [...new Set(run.trials.flatMap((report) => report.case?.tags ?? []))].sort();
  const tagged = (tag: string) =>
    run.trials.filter((report) => report.case?.tags?.includes(tag) === true);
  const verdictsOf = (trials: readonly TrialReport[]) => {
    const ids = new Set(trials.map((report) => report.case?.id));
    return run.verdicts.filter((verdict) => ids.has(verdict.case));
  };
  return [
    groupOf('all', run.verdicts, run.trials, gradesAnswers),
    ...tags.map((tag) => {
      const trials = tagged(tag);
      return groupOf(tag, verdictsOf(trials), trials, gradesAnswers);
    }),
  ];
}

export type { GroupSummary, Spread };
export { groupSummaries };
