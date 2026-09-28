/**
 * `agents eval <suite>`: load a suite module, run it live (with the provider
 * the host passes or the suite exports) or over recorded traces, and print
 * every case's verdict. Exit status follows the pass threshold.
 *
 * @module
 */

import { runSuite, type SuiteRun, type TrialReport } from '../../evals/run.ts';
import { loadSuite, readTraceRecords } from '../../evals/suite.ts';
import { summarizeRun } from '../../evals/summary.ts';
import type { RunDecisionOptions } from '../../kernel/engine/decision.ts';
import type { ModelProvider } from '../../kernel/types.ts';
import { jsonlSink } from '../../observability/trace.ts';

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

function fraction(run: SuiteRun): number {
  if (run.verdicts.length === 0) return 0;
  return run.verdicts.filter((verdict) => verdict.passed).length / run.verdicts.length;
}

/** The results that kept a trial from passing, worded by their graders. */
function blame(report: TrialReport): string[] {
  return report.results.flatMap((result) => {
    if (result.passed === true) return [];
    if (result.errorType) return [`${result.name}: ${result.errorType}`];
    if (result.passed === false) return [`${result.name}: ${result.explanation ?? 'failed'}`];
    return [];
  });
}

function printTable(run: SuiteRun): void {
  const width = Math.max(4, ...run.verdicts.map((verdict) => verdict.case.length));
  console.log(`\n▶ [EVAL] Suite: ${run.suite} (${run.mode}, ${run.repeat} trials per case)\n`);
  console.log(`  ${'case'.padEnd(width)}  kind        passed  result`);
  for (const verdict of run.verdicts) {
    const mark = verdict.passed ? `${GREEN}pass${RESET}` : `${RED}fail${RESET}`;
    const counts = `${verdict.trialsPassed}/${verdict.trials}`;
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
  const passed = run.verdicts.filter((verdict) => verdict.passed).length;
  console.log(`\n  ${passed}/${run.verdicts.length} cases passed; cost $${run.costUsd.toFixed(4)}`);
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
  provider?: ModelProvider;
  /** The provider for text judge profiles. */
  judgeProvider?: ModelProvider;
  /** The key for decision judge profiles (Jev). */
  judgeDecision?: Omit<RunDecisionOptions, 'sink'>;
}

/**
 * Run or grade a suite and report it. Returns whether the run met the
 * threshold; a run stopped on budget never does. The CLI never creates a
 * provider or reads a key: live mode takes the provider the host passes or
 * the suite exports; a text judge takes `judgeProvider`, the suite's
 * `judgeProvider` export, or the agent's provider; a decision judge takes
 * `judgeDecision` or the suite's `judgeDecision` export.
 */
export async function evalCommand(options: EvalOptions, host: EvalHost = {}): Promise<boolean> {
  const { provider, judgeProvider, judgeDecision } = host;
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
