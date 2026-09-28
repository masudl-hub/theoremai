/**
 * `runSuite`: every case, `repeat` times, graded from the trace. Live mode
 * runs the profile now through `runTurn` with the host's provider and grades
 * what the memory sink caught; recorded mode grades records a host already
 * has. Both build the same trials, so the same graders give the same results.
 *
 * Every trial's results become a `theorem.eval.trial` span in the judged
 * trace; the run becomes one `theorem.eval.run` record. Both go to the sink
 * the host names, or nowhere.
 *
 * @module
 */

import { errorKind, TheoremError } from '../guardrails/error.ts';
import { getProfile, runTurn } from '../kernel/default-scope.ts';
import type { RunDecisionOptions } from '../kernel/engine/decision.ts';
import { isModelProfile } from '../kernel/registry/resolve.ts';
import type { ModelProvider, TurnRequest } from '../kernel/types.ts';
import { isRecord } from '../kernel/util/record.ts';
import { resolveObservabilityPolicy } from '../observability/resolve-policy.ts';
import { memorySink, writeTrace } from '../observability/trace.ts';
import type { TraceRecord } from '../observability/trace-record.ts';
import type { TraceSink } from '../observability/trace-sink.ts';
import type { TraceClock, TraceSpan } from '../observability/trace-span.ts';
import type { ResolvedObservabilityPolicy } from '../observability/types.ts';
import { buildRunRecord, buildTrialRecord, type GradedResult } from './record.ts';
import type { LoadedSuite } from './suite.ts';
import { buildTrial, groupByTrace, hasTurn } from './trial.ts';
import type { EvalCase, EvalGradeContext, EvalGrader, EvalResult, Trial } from './types.ts';
import { type CaseVerdict, caseVerdict, type TrialOutcome, trialOutcome } from './verdict.ts';

/** How the eval stamps a live turn so recorded mode can match its record to the case. */
interface EvalStamp {
  suite: string;
  case: string;
  trial: number;
}

/** One trial as the run reports it, before and after it is written. */
interface TrialReport {
  case?: EvalCase;
  index: number;
  outcome: TrialOutcome;
  results: EvalResult[];
  /** The judged trace, when the turn produced one. */
  traceId?: string;
  records: TraceRecord[];
  /** The kind of the error that stopped the turn before it had a trace, if any. */
  error?: string;
  /** The turn's cost from its root, when it recorded one. */
  costUsd?: number;
  /** The judge calls' summed cost, when a model grader ran and any judge recorded one. */
  judgeCostUsd?: number;
  /** Every judge call's records, one trace per judge call. */
  judgeRecords: TraceRecord[];
  /** The written `theorem.eval.trial` record, when there was a trace to hold it. */
  trialRecord?: TraceRecord;
}

interface RunSuiteOptions {
  /** Live mode: the host's provider for the profile under test. */
  provider?: ModelProvider;
  /** The provider for text judge profiles; default the suite's `judgeProvider` export, else `provider`. */
  judgeProvider?: ModelProvider;
  /** The key for decision judge profiles (Jev); default the suite's `judgeDecision` export. */
  judgeDecision?: Omit<RunDecisionOptions, 'sink'>;
  /** Recorded mode: the records to grade; live mode when absent. */
  recorded?: TraceRecord[];
  /** Where trial and run records go. Absent: they are returned only. */
  sink?: TraceSink;
  /** Stop starting trials once the summed cost (agent and judge) crosses this; the run record says `stopped: budget`. */
  maxCostUsd?: number;
  /** `repeat` override from the command line. */
  repeat?: number;
  /** Live mode: trials in flight at once (default 1). Order of start and report is the suite's either way. */
  concurrency?: number;
  /** `vcs.ref.head.revision` on the run record. */
  revision?: string;
  clock?: TraceClock;
  /** Called after each trial is graded, for progress output. */
  onTrial?: (report: TrialReport) => void;
  signal?: AbortSignal;
}

/** What a run produced. */
interface SuiteRun {
  suite: string;
  mode: 'live' | 'recorded';
  repeat: number;
  verdicts: CaseVerdict[];
  trials: TrialReport[];
  /** Recorded mode: trials whose records carried no matching case. */
  caseless: TrialReport[];
  /** Every case verdict passed and nothing stopped the run. */
  passed: boolean;
  stopped?: 'budget';
  /** The summed cost, agent turns and judge turns, over every trial that recorded one. */
  costUsd: number;
  /** Plain-language warnings for the host to print. */
  warnings: string[];
  run: TraceRecord;
}

/** A judge turn's stamp carries `judge`; the turn it judged does not. */
function isJudgeStamp(record: TraceRecord): boolean {
  const stamp = record.metadata?.eval;
  return isRecord(stamp) && stamp.judge !== undefined;
}

function stampOf(record: TraceRecord | undefined): EvalStamp | undefined {
  const stamp = record?.metadata?.eval;
  if (!isRecord(stamp) || stamp.judge !== undefined) return undefined;
  const { suite, case: caseId, trial } = stamp;
  if (typeof suite !== 'string' || typeof caseId !== 'string' || typeof trial !== 'number') {
    return undefined;
  }
  return { suite, case: caseId, trial };
}

/** Grade one trial with every grader that applies; a grader that throws yields `grader_error`. */
async function gradeTrial(
  graders: EvalGrader[],
  trial: Trial,
  context: EvalGradeContext,
): Promise<GradedResult[]> {
  const applicable = trial.case ? graders : graders.filter((grader) => !grader.needsExpect);
  const out: GradedResult[] = [];
  for (const grader of applicable) {
    try {
      out.push({ result: await grader.grade(trial, context), graderIdentity: grader.identity });
    } catch (thrown) {
      out.push({
        result: {
          name: grader.name,
          source: grader.source,
          errorType: 'grader_error',
          explanation: thrown instanceof Error ? thrown.message : String(thrown),
        },
        graderIdentity: grader.identity,
      });
    }
  }
  return out;
}

/** Every applicable grader's result as the error that kept the turn from producing a trace. */
function erroredResults(
  graders: EvalGrader[],
  evalCase: EvalCase | undefined,
  error: string,
): EvalResult[] {
  const applicable = evalCase ? graders : graders.filter((grader) => !grader.needsExpect);
  return applicable.map((grader) => ({
    name: grader.name,
    source: grader.source,
    errorType: error,
  }));
}

/** What model graders judge with: the suite's judge, the host's provider and key, each judge's policy. */
interface Judging {
  suiteJudge?: string;
  provider?: ModelProvider;
  decision?: Omit<RunDecisionOptions, 'sink'>;
  /** Each judge profile a grader runs, by id, with the observability policy its records are written under. */
  policies: Map<string, ResolvedObservabilityPolicy>;
}

interface Grading {
  suite: LoadedSuite;
  policy: ResolvedObservabilityPolicy;
  judging: Judging;
  sink?: TraceSink;
  clock?: TraceClock;
  trialSpans: TraceSpan[];
  signal?: AbortSignal;
}

function recordRoot(record: TraceRecord): TraceSpan | undefined {
  return record.spans.find((span) => span.parentSpanId === undefined) ?? record.spans[0];
}

/** A record's root cost, when its root recorded one. */
function recordCost(record: TraceRecord): number | undefined {
  const cost = recordRoot(record)?.attributes['theorem.usage.cost_usd'];
  return typeof cost === 'number' ? cost : undefined;
}

/** The profile a record ran on (`gen_ai.agent.name` on its root). */
function recordAgent(record: TraceRecord): string | undefined {
  const agent = recordRoot(record)?.attributes['gen_ai.agent.name'];
  return typeof agent === 'string' ? agent : undefined;
}

/** Build, grade and write one trial from the records of one trace. */
async function gradeRecords(
  grading: Grading,
  evalCase: EvalCase | undefined,
  index: number,
  records: TraceRecord[],
): Promise<TrialReport> {
  const trial = buildTrial({ suite: grading.suite.suite.id, case: evalCase, index, records });
  const judgeRecords: TraceRecord[] = [];
  let judgeCostUsd: number | undefined;
  const { judging } = grading;
  const context: EvalGradeContext = {
    ...(judging.suiteJudge ? { judge: judging.suiteJudge } : {}),
    ...(judging.provider ? { judgeProvider: judging.provider } : {}),
    ...(judging.decision ? { judgeDecision: judging.decision } : {}),
    traced: async (traced) => {
      for (const record of traced) {
        judgeRecords.push(record);
        const cost = recordCost(record);
        if (cost !== undefined) judgeCostUsd = (judgeCostUsd ?? 0) + cost;
        const policy = judging.policies.get(recordAgent(record) ?? '');
        if (grading.sink && policy) await writeTrace(grading.sink, Promise.resolve(record), policy);
      }
    },
    ...(grading.signal ? { signal: grading.signal } : {}),
  };
  const graded = await gradeTrial(grading.suite.suite.graders, trial, context);
  const results = graded.map((entry) => entry.result);
  const built = await buildTrialRecord({
    trial,
    results: graded,
    policy: grading.policy,
    ...(grading.clock ? { clock: grading.clock } : {}),
  });
  grading.trialSpans.push(built.span);
  if (grading.sink) await writeTrace(grading.sink, Promise.resolve(built.record), grading.policy);
  const costUsd = trial.usage().costUsd;
  return {
    ...(evalCase ? { case: evalCase } : {}),
    index,
    outcome: trialOutcome(results),
    results,
    traceId: trial.root.traceId,
    records,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(judgeCostUsd === undefined ? {} : { judgeCostUsd }),
    judgeRecords,
    trialRecord: built.record,
  };
}

function turnRequest(suite: LoadedSuite, evalCase: EvalCase, index: number): TurnRequest {
  if ('session' in evalCase.input) {
    throw new TheoremError(
      'config',
      `case ${evalCase.id} is a session script; suite ${suite.suite.id} runs turns`, // lexicon-exempt: developer contract error
    );
  }
  const stamp: EvalStamp = { suite: suite.suite.id, case: evalCase.id, trial: index };
  return {
    profile: suite.suite.profile,
    input: {
      ...(evalCase.input.text === undefined ? {} : { text: evalCase.input.text }),
      ...(evalCase.input.attachments ? { attachments: evalCase.input.attachments } : {}),
    },
    metadata: { eval: stamp },
  };
}

/** Run one turn live; its records are what the memory sink caught. */
async function runLiveTrial(
  grading: Grading,
  provider: ModelProvider,
  evalCase: EvalCase,
  index: number,
  signal: AbortSignal | undefined,
): Promise<TrialReport> {
  const records: TraceRecord[] = [];
  let thrown: unknown;
  try {
    const request = {
      ...turnRequest(grading.suite, evalCase, index),
      ...(signal ? { signal } : {}),
    };
    for await (const _event of runTurn(request, provider, memorySink(records))) {
      // The trace is the record of the turn; events are not graded.
    }
  } catch (error) {
    thrown = error;
  }
  if (records.length > 0) {
    // The turn's own records go to the host's sink too: a label points at a transcript someone can read.
    if (grading.sink) {
      for (const record of records) {
        await writeTrace(grading.sink, Promise.resolve(record), grading.policy);
      }
    }
    return gradeRecords(grading, evalCase, index, records);
  }
  const error = thrown === undefined ? 'internal' : errorKind(thrown);
  const results = erroredResults(grading.suite.suite.graders, evalCase, error);
  return {
    case: evalCase,
    index,
    outcome: trialOutcome(results),
    results,
    records,
    judgeRecords: [],
    error,
  };
}

/**
 * What the suite's model graders judge with. Each grader names its judge
 * profile (its own, else the suite's); a text judge needs a provider (the
 * option, else the suite's `judgeProvider` export, else the agent's), a
 * decision judge a key (the option, else the suite's `judgeDecision` export).
 */
function judgingOf(loaded: LoadedSuite, options: RunSuiteOptions): Judging {
  const { suite } = loaded;
  const provider = options.judgeProvider ?? loaded.judgeProvider ?? options.provider;
  const decision = options.judgeDecision ?? loaded.judgeDecision;
  const policies = new Map<string, ResolvedObservabilityPolicy>();
  for (const grader of suite.graders) {
    if (!grader.judgeProfile) continue;
    const id = grader.judgeProfile(suite.judge?.profile);
    const profile = getProfile(id);
    if (profile.type === 'decision' && !decision) {
      throw new TheoremError(
        'config',
        `suite ${suite.id}: grader ${grader.name} needs a key for decision judge profile ${id}; export judgeDecision`, // lexicon-exempt: developer contract error
      );
    }
    if (profile.type !== 'decision' && !provider) {
      throw new TheoremError(
        'config',
        `suite ${suite.id}: grader ${grader.name} needs a provider for judge profile ${id}`, // lexicon-exempt: developer contract error
      );
    }
    policies.set(id, resolveObservabilityPolicy(profile.observability));
  }
  return {
    ...(suite.judge ? { suiteJudge: suite.judge.profile } : {}),
    ...(provider ? { provider } : {}),
    ...(decision ? { decision } : {}),
    policies,
  };
}

function checkSuite(loaded: LoadedSuite, options: RunSuiteOptions): string[] {
  const { suite } = loaded;
  const profile = getProfile(suite.profile);
  if (!isModelProfile(profile)) {
    throw new TheoremError(
      'config',
      `suite ${suite.id}: profile ${suite.profile} runs no model turn`,
    ); // lexicon-exempt: developer contract error
  }
  if (suite.mode === 'session') {
    throw new TheoremError('config', `suite ${suite.id}: session suites are not run yet`); // lexicon-exempt: developer contract error
  }
  if (profile.type === 'live') {
    throw new TheoremError('config', `suite ${suite.id}: a live profile needs mode 'session'`); // lexicon-exempt: developer contract error
  }
  if (!options.recorded && !options.provider) {
    throw new TheoremError('config', `suite ${suite.id}: live mode needs a provider`); // lexicon-exempt: developer contract error
  }
  if (suite.graders.length === 0) {
    throw new TheoremError('config', `suite ${suite.id}: no graders`); // lexicon-exempt: developer contract error
  }
  const warnings: string[] = [];
  const repeat = options.repeat ?? suite.trials.repeat;
  if (repeat === 1) {
    warnings.push(
      'one trial per case cannot tell noise from change; set trials.repeat to 3 or more',
    );
  }
  return warnings;
}

/** A trial's whole cost: the agent's turn and its judge turns. */
function reportCost(report: TrialReport): number {
  return (report.costUsd ?? 0) + (report.judgeCostUsd ?? 0);
}

/** What either mode produced, before verdicts. */
interface Ran {
  byCase: Map<string, TrialReport[]>;
  caseless: TrialReport[];
  stopped?: 'budget';
  costUsd: number;
  /** Recorded mode: traces that were not turns to grade (judge turns, eval run records). */
  skipped?: { judge: number; other: number };
}

function summedCost(reports: TrialReport[]): number {
  return reports.reduce((sum, report) => sum + reportCost(report), 0);
}

/** Recorded mode: each trace's records become one trial, matched to a case by its eval stamp. */
async function gradeRecorded(grading: Grading, records: TraceRecord[]): Promise<Ran> {
  const byCase = new Map<string, TrialReport[]>();
  const caseless: TrialReport[] = [];
  const cases = new Map(grading.suite.cases.map((evalCase) => [evalCase.id, evalCase]));
  const skipped = { judge: 0, other: 0 };
  for (const [, traceRecords] of groupByTrace(records)) {
    // A directory of eval traces holds judge turns and run records beside the turns; only turns are trials.
    if (traceRecords.some(isJudgeStamp)) {
      skipped.judge += 1;
      continue;
    }
    if (!hasTurn(traceRecords)) {
      skipped.other += 1;
      continue;
    }
    const stamp = traceRecords
      .map(stampOf)
      .find((found) => found?.suite === grading.suite.suite.id);
    const evalCase = stamp ? cases.get(stamp.case) : undefined;
    if (!evalCase) {
      caseless.push(await gradeRecords(grading, undefined, caseless.length, traceRecords));
      continue;
    }
    const index = stamp?.trial ?? 0;
    const report = await gradeRecords(grading, evalCase, index, traceRecords);
    byCase.set(evalCase.id, [...(byCase.get(evalCase.id) ?? []), report]);
  }
  const reports = [...byCase.values(), caseless].flat();
  return { byCase, caseless, costUsd: summedCost(reports), skipped };
}

/**
 * Live mode: every case, `repeat` times, started in suite order with up to
 * `concurrency` in flight, until the cost ceiling. The ceiling is checked
 * before each start, so a stop lets what is in flight finish and count.
 */
async function runLive(
  grading: Grading,
  provider: ModelProvider,
  repeat: number,
  options: RunSuiteOptions,
): Promise<Ran> {
  const jobs = grading.suite.cases.flatMap((evalCase) =>
    Array.from({ length: repeat }, (_, index) => ({ evalCase, index })),
  );
  const reports = new Map<string, TrialReport[]>(
    grading.suite.cases.map((evalCase) => [evalCase.id, []]),
  );
  let next = 0;
  let costUsd = 0;
  let stopped: 'budget' | undefined;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      if (options.maxCostUsd !== undefined && costUsd > options.maxCostUsd) {
        stopped = 'budget';
        return;
      }
      const job = jobs[next++];
      if (!job) return;
      const report = await runLiveTrial(grading, provider, job.evalCase, job.index, options.signal);
      costUsd += reportCost(report);
      reports.get(job.evalCase.id)?.push(report);
      options.onTrial?.(report);
    }
  };
  const workers = Math.max(1, Math.min(options.concurrency ?? 1, jobs.length));
  await Promise.all(Array.from({ length: workers }, worker));
  const byCase = new Map<string, TrialReport[]>();
  for (const [id, list] of reports) {
    byCase.set(
      id,
      [...list].sort((a, b) => a.index - b.index),
    );
  }
  return { byCase, caseless: [], ...(stopped ? { stopped } : {}), costUsd };
}

async function ranOf(grading: Grading, repeat: number, options: RunSuiteOptions): Promise<Ran> {
  if (options.recorded !== undefined) {
    const ran = await gradeRecorded(grading, options.recorded);
    for (const report of [...ran.byCase.values(), ran.caseless].flat()) options.onTrial?.(report);
    return ran;
  }
  if (!options.provider) {
    throw new TheoremError('config', `suite ${grading.suite.suite.id}: live mode needs a provider`); // lexicon-exempt: developer contract error
  }
  return runLive(grading, options.provider, repeat, options);
}

/** Run a loaded suite live or over records, write its trial and run records, and report every verdict. */
async function runSuite(loaded: LoadedSuite, options: RunSuiteOptions = {}): Promise<SuiteRun> {
  const warnings = checkSuite(loaded, options);
  const { suite } = loaded;
  const repeat = options.repeat ?? suite.trials.repeat;
  const profile = getProfile(suite.profile);
  const policy = resolveObservabilityPolicy(
    isModelProfile(profile) ? profile.observability : undefined,
  );
  const grading: Grading = {
    suite: loaded,
    policy,
    judging: judgingOf(loaded, options),
    ...(options.sink ? { sink: options.sink } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    trialSpans: [],
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const ran = await ranOf(grading, repeat, options);
  if (ran.skipped && ran.skipped.judge + ran.skipped.other > 0) {
    warnings.push(
      `skipped ${ran.skipped.judge} judge trace(s) and ${ran.skipped.other} record(s) with no turn; they are not trials`,
    );
  }
  const rule = suite.trials.pass ?? 'all';
  const verdicts = loaded.cases.map((evalCase) =>
    caseVerdict(
      evalCase,
      (ran.byCase.get(evalCase.id) ?? []).map((report) => report.results),
      rule,
    ),
  );
  const run = await buildRunRecord({
    suite: {
      id: suite.id,
      trials: { repeat, ...(suite.trials.pass ? { pass: suite.trials.pass } : {}) },
    },
    verdicts,
    trialSpans: grading.trialSpans,
    policy,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(ran.caseless.length > 0 ? { caseless: true } : {}),
    ...(ran.stopped ? { stopped: ran.stopped } : {}),
    ...(options.revision ? { revision: options.revision } : {}),
  });
  if (options.sink) await writeTrace(options.sink, Promise.resolve(run), policy);
  const trials = [...ran.byCase.values()].flat();
  return {
    suite: suite.id,
    mode: options.recorded !== undefined ? 'recorded' : 'live',
    repeat,
    verdicts,
    trials,
    caseless: ran.caseless,
    passed: ran.stopped === undefined && verdicts.every((verdict) => verdict.passed),
    ...(ran.stopped ? { stopped: ran.stopped } : {}),
    costUsd: ran.costUsd,
    warnings,
    run,
  };
}

export type { RunSuiteOptions, SuiteRun, TrialReport };
export { runSuite };
