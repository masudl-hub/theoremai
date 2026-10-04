import type { SuiteRun, TrialReport } from './run.ts';
import type { CaseVerdict } from './verdict.ts';

/** Nearest-rank percentiles, so each is a value some trial had. */
interface Spread {
  median: number;
  p90: number;
}

interface GroupSummary {
  group: string;
  cases: number;
  casesPassed: number;
  casesUndecided: number;
  trials: number;
  trialsPassed: number;
  trialsErrored: number;
  answers?: { accepted: number; partial: number; wrong: number; none: number };
  stops: Record<string, number>;
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
