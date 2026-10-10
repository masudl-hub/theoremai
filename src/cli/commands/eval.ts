import { groupSummaries, type Spread } from '../../evals/breakdown.ts';
import { runSuite, type SuiteRun, type TrialReport } from '../../evals/run.ts';
import { loadSuite, readTraceRecords } from '../../evals/suite.ts';
import { summarizeRun } from '../../evals/summary.ts';
import type { EvalMediaResolver, EvalPassRule } from '../../evals/types.ts';
import type { RunDecisionOptions } from '../../kernel/engine/decision.ts';
import type { ProviderHostOptions } from '../../kernel/provider-contract.ts';
import { jsonlSink } from '../../observability/jsonl.ts';

export interface EvalOptions {
  /** Path of the suite module (`export default` an `EvalSuite`). */
  suite: string;
  /** Grade these records (a JSONL file or a directory of them) instead of running the profile. */
  recorded?: string;
  /** Trials per case, overriding the suite's `trials.repeat`. */
  trials?: number;
  /** Trials in flight at once (default 1). */
  concurrency?: number;
  /** Append trial and run records as JSONL under this directory. */
  traceDir?: string;
  /** Print the run as one JSON document instead of the table. */
  json?: boolean;
  /** Stop starting trials once the run's cost passes this. */
  maxCostUsd?: number;
  /** The fraction of cases that must pass for exit 0 (default 1: every case). */
  threshold?: number;
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function failed(message: string): false {
  console.error(`\n${RED}Eval Failed${RESET}: ${message}\n`);
  return false;
}

/** Passed over decided cases: a case every trial of which errored is not a failure. */
function fraction(run: SuiteRun): number {
  const decided = run.verdicts.filter((verdict) => verdict.decided);
  if (decided.length === 0) return 0;
  return decided.filter((verdict) => verdict.passed).length / decided.length;
}

/** `part/whole pct`, with what the pass rate leaves out after it. */
function rate(part: number, whole: number, left: number, what: string): string {
  return `${part}/${whole} ${percent(part, whole)}${left > 0 ? ` (+${left} ${what})` : ''}`;
}

function blame(report: TrialReport): string[] {
  return report.results.flatMap((result) => {
    if (result.passed === true) return [];
    if (result.errorType) {
      const why = result.explanation ? ` (${result.explanation})` : '';
      return [`${result.name}: ${result.errorType}${why}`];
    }
    if (result.passed === false) return [`${result.name}: ${result.explanation ?? 'failed'}`];
    return [];
  });
}

/** The run's cost, never a zero standing in for calls whose provider reported none. */
function costLine(run: SuiteRun): string {
  if (run.unpriced === 0) return `cost $${run.costUsd.toFixed(4)}`;
  const calls = `${run.unpriced} call${run.unpriced === 1 ? '' : 's'}`;
  if (run.priced === 0) return `cost not reported (${calls})`;
  return `cost $${run.costUsd.toFixed(4)}, plus ${calls} whose cost went unreported`;
}

/** What a case passing means under the rule, over `k` trials. */
function ruleName(rule: EvalPassRule): string {
  if (rule === 'all') return 'pass^k';
  if (rule === 'any') return 'pass@k';
  return `>=${rule.atLeast}/k`;
}

function percent(part: number, whole: number): string {
  return whole === 0 ? '-' : `${Math.round((part / whole) * 100)}%`;
}

function spreadText(spread: Spread | undefined, unit = ''): string {
  return spread ? `${spread.median}${unit} / ${spread.p90}${unit}` : '-';
}

/** Every cased trial, then each tag's: how often right, how consistently, how long, how many loops. */
function printGroups(run: SuiteRun): void {
  const groups = groupSummaries(run);
  const rows = groups.map((group) => [
    group.group,
    rate(group.casesPassed, group.cases - group.casesUndecided, group.casesUndecided, 'undecided'),
    rate(group.trialsPassed, group.trials - group.trialsErrored, group.trialsErrored, 'errored'),
    group.answers
      ? `${group.answers.accepted}/${group.answers.partial}/${group.answers.wrong}${group.answers.none > 0 ? ` (+${group.answers.none} none)` : ''}`
      : '-',
    spreadText(group.durationMs, 'ms'),
    spreadText(group.modelCalls),
    spreadText(group.toolCalls),
    Object.entries(group.stops)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([stop, count]) => `${stop} ${count}`)
      .join(', ') || '-',
  ]);
  const header = [
    'group',
    `cases ${ruleName(run.passRule)}`,
    'trials passed',
    'accepted/partial/wrong',
    'turn median / p90',
    'model calls',
    'tool calls',
    'stops',
  ];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    `  ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ')}`;
  console.log('');
  console.log(line(header));
  for (const row of rows) console.log(line(row));
}

function printTable(run: SuiteRun): void {
  const width = Math.max(4, ...run.verdicts.map((verdict) => verdict.case.length));
  console.log(`\n▶ [EVAL] Suite: ${run.suite} (${run.mode}, ${run.repeat} trials per case)\n`);
  console.log(`  ${'case'.padEnd(width)}  kind        passed  result`);
  for (const verdict of run.verdicts) {
    const mark = verdict.passed
      ? `${GREEN}pass${RESET}`
      : verdict.decided
        ? `${RED}fail${RESET}`
        : `${YELLOW}undecided${RESET}`;
    const counts = `${verdict.trialsPassed}/${verdict.trials - verdict.trialsErrored}`;
    const extra = [
      verdict.trialsErrored > 0 ? `${verdict.trialsErrored} errored` : '',
      verdict.trialsUngraded > 0 ? `${verdict.trialsUngraded} ungraded` : '',
    ]
      .filter(Boolean)
      .join(', ');
    console.log(
      `  ${verdict.case.padEnd(width)}  ${verdict.kind.padEnd(10)}  ${counts.padEnd(6)}  ${mark}${extra ? ` ${DIM}(${extra})${RESET}` : ''}`,
    );
  }
  for (const verdict of run.verdicts) {
    if (verdict.passed) continue;
    const reports = run.trials.filter((report) => report.case?.id === verdict.case);
    for (const report of reports) {
      const reasons = blame(report);
      if (reasons.length === 0) continue;
      console.log(`\n  ${verdict.case} trial ${report.index}:`);
      for (const reason of reasons) console.log(`    ${DIM}·${RESET} ${reason}`);
    }
  }
  if (run.caseless.length > 0) {
    console.log(
      `\n  ${DIM}${run.caseless.length} trace(s) carried no case stamp for this suite; graded without a case, no verdict.${RESET}`,
    );
  }
  printGroups(run);
  const passed = run.verdicts.filter((verdict) => verdict.passed).length;
  const decided = run.verdicts.filter((verdict) => verdict.decided).length;
  const undecided = run.verdicts.length - decided;
  console.log(
    `\n  ${passed}/${decided} cases passed${undecided > 0 ? ` (+${undecided} undecided)` : ''}; ${costLine(run)}`,
  );
  if (run.stopped) console.log(`  ${YELLOW}stopped on ${run.stopped}${RESET}`);
  for (const warning of run.warnings) console.log(`  ${YELLOW}warning${RESET}: ${warning}`);
  console.log('');
}

function printJson(run: SuiteRun): void {
  console.log(JSON.stringify(summarizeRun(run), null, 2));
}

/** What the host hands the eval command: providers and keys it never creates or reads itself. */
export interface EvalHost {
  /** The provider for the profile under test. */
  provider?: ProviderHostOptions;
  /** The provider for text judge profiles. */
  judgeProvider?: ProviderHostOptions;
  /** The key for decision judge profiles (Jev). */
  judgeDecision?: Omit<RunDecisionOptions, 'sink'>;
  /** Where a judge finds media a trace names only by hash. */
  media?: EvalMediaResolver;
}

/**
 * Returns whether the run met the threshold; a run stopped on budget never does. The CLI never
 * creates a provider or reads a key: the host passes them or the suite module exports them.
 */
export async function evalCommand(options: EvalOptions, host: EvalHost = {}): Promise<boolean> {
  const { provider, judgeProvider, judgeDecision, media } = host;
  const threshold = options.threshold ?? 1;
  if (!(threshold >= 0 && threshold <= 1)) return failed('--threshold is a fraction from 0 to 1.');
  if (options.trials !== undefined && !(Number.isInteger(options.trials) && options.trials > 0)) {
    return failed('--trials is a whole number of trials per case, 1 or more.');
  }
  if (
    options.concurrency !== undefined &&
    !(Number.isInteger(options.concurrency) && options.concurrency > 0)
  ) {
    return failed('--concurrency is a whole number of trials in flight, 1 or more.');
  }
  let run: SuiteRun;
  try {
    const loaded = await loadSuite(options.suite);
    const recorded = options.recorded ? await readTraceRecords(options.recorded) : undefined;
    const live = provider ?? loaded.provider;
    if (!recorded && !live) {
      return failed(
        'Theorem CLI does not create providers or read keys. Export `provider` from the suite module, or pass --recorded <traces>.',
      );
    }
    run = await runSuite(loaded, {
      ...(recorded ? { recorded } : {}),
      ...(live ? { provider: live } : {}),
      ...(judgeProvider ? { judgeProvider } : {}),
      ...(judgeDecision ? { judgeDecision } : {}),
      ...(media ? { media } : {}),
      ...(options.trials !== undefined ? { repeat: options.trials } : {}),
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
      ...(options.maxCostUsd !== undefined ? { maxCostUsd: options.maxCostUsd } : {}),
      ...(options.traceDir?.trim() ? { sink: jsonlSink(options.traceDir.trim()) } : {}),
    });
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
  if (options.json) printJson(run);
  else printTable(run);
  return run.stopped === undefined && fraction(run) >= threshold;
}
