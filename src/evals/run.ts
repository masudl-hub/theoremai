import { errorKind, TheoremError } from '../guardrails/error.ts';
import { getProfile, runTurn } from '../kernel/default-scope.ts';
import type { RunDecisionOptions } from '../kernel/engine/decision.ts';
import type { ProviderHostOptions } from '../kernel/provider-contract.ts';
import { isModelProfile } from '../kernel/registry/resolve.ts';
import type { TurnRequest } from '../kernel/types.ts';
import { isRecord } from '../kernel/util/record.ts';
import { resolveObservabilityPolicy } from '../observability/resolve-policy.ts';
import { memorySink, writeTrace } from '../observability/trace.ts';
import type { TraceRecord } from '../observability/trace-record.ts';
import type { TraceSink } from '../observability/trace-sink.ts';
import type { TraceClock, TraceSpan } from '../observability/trace-span.ts';
import type { ResolvedObservabilityPolicy } from '../observability/types.ts';
import { attachmentData } from './attachments.ts';
import { modelCalls, spanDurationMs } from './graders/shared.ts';
import { buildRunRecord, type GradedResult, startTrialRecord } from './record.ts';
import type { LoadedSuite } from './suite.ts';
import { buildTrial, groupByTrace, hasTurn } from './trial.ts';
import type {
  EvalCase,
  EvalGradeContext,
  EvalGrader,
  EvalMediaResolver,
  EvalPassRule,
  EvalResult,
  Trial,
} from './types.ts';
import { type CaseVerdict, caseVerdict, type TrialOutcome, trialOutcome } from './verdict.ts';

/** Names a trial by suite, case and trial number. */
interface EvalStamp {
  suite: string;
  case: string;
  trial: number;
}

/** The size of a turn: its duration and the model and tool calls it made. */
interface TurnShape {
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
  stop?: string;
}

/** One trial's outcome, results and records. */
interface TrialReport {
  case?: EvalCase;
  index: number;
  outcome: TrialOutcome;
  results: EvalResult[];
  traceId?: string;
  records: TraceRecord[];
  turn?: TurnShape;
  error?: string;
  costUsd?: number;
  judgeCostUsd?: number;
  unpriced: number;
  priced: number;
  judgeRecords: TraceRecord[];
  trialRecord?: TraceRecord;
}

/** Options for `runSuite`: the providers, the judge and how often to repeat. */
interface RunSuiteOptions {
  provider?: ProviderHostOptions;
  judgeProvider?: ProviderHostOptions;
  judgeDecision?: Omit<RunDecisionOptions, 'sink'>;
  media?: EvalMediaResolver;
  recorded?: TraceRecord[];
  sink?: TraceSink;
  maxCostUsd?: number;
  repeat?: number;
  concurrency?: number;
  revision?: string;
  clock?: TraceClock;
  onTrial?: (report: TrialReport) => void;
  signal?: AbortSignal;
}

/** A finished suite run: its mode and its cases' trials and verdicts. */
interface SuiteRun {
  suite: string;
  mode: 'live' | 'recorded';
  repeat: number;
  passRule: EvalPassRule;
  verdicts: CaseVerdict[];
  trials: TrialReport[];
  caseless: TrialReport[];
  passed: boolean;
  stopped?: 'budget';
  costUsd: number;
  unpriced: number;
  priced: number;
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

/** Judge records reach `context.traced` in grader order once every grader is done, so a run writes the same records in the same order whichever judge answered first. */
async function gradeTrial(
  graders: EvalGrader[],
  trial: Trial,
  context: EvalGradeContext,
): Promise<GradedResult[]> {
  const applicable = trial.case ? graders : graders.filter((grader) => !grader.needsExpect);
  const graded = await Promise.all(
    applicable.map(async (grader) => {
      const records: TraceRecord[] = [];
      const own: EvalGradeContext = {
        ...context,
        traced: (traced) => {
          records.push(...traced);
        },
      };
      try {
        return { records, result: await grader.grade(trial, own), graderIdentity: grader.identity };
      } catch (thrown) {
        return {
          records,
          result: {
            name: grader.name,
            source: grader.source,
            errorType: 'grader_error',
            explanation: thrown instanceof Error ? thrown.message : String(thrown),
          },
          graderIdentity: grader.identity,
        };
      }
    }),
  );
  for (const { records } of graded) await context.traced(records);
  return graded.map(({ result, graderIdentity }) => ({ result, graderIdentity }));
}

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

interface Judging {
  suiteJudge?: string;
  provider?: ProviderHostOptions;
  decision?: Omit<RunDecisionOptions, 'sink'>;
  media?: EvalMediaResolver;
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

/** The record's root: the span no other span in it parents (a judge call's root has the trial span above it). */
function recordRoot(record: TraceRecord): TraceSpan | undefined {
  const ids = new Set(record.spans.map((span) => span.spanId));
  return record.spans.find(
    (span) => span.parentSpanId === undefined || !ids.has(span.parentSpanId),
  );
}

function recordCost(record: TraceRecord): { usd?: number; whole: boolean } {
  const attributes = recordRoot(record)?.attributes;
  const cost = attributes?.['theorem.usage.cost_usd'];
  if (typeof cost !== 'number') return { whole: false };
  return { usd: cost, whole: attributes?.['theorem.usage.cost_partial'] !== true };
}

function recordAgent(record: TraceRecord): string | undefined {
  const agent = recordRoot(record)?.attributes['gen_ai.agent.name'];
  return typeof agent === 'string' ? agent : undefined;
}

async function gradeRecords(
  grading: Grading,
  evalCase: EvalCase | undefined,
  index: number,
  records: TraceRecord[],
): Promise<TrialReport> {
  const trial = buildTrial({ suite: grading.suite.suite.id, case: evalCase, index, records });
  const trialRecord = startTrialRecord({
    trial,
    policy: grading.policy,
    ...(grading.clock ? { clock: grading.clock } : {}),
  });
  const usage = trial.usage();
  const judgeRecords: TraceRecord[] = [];
  let judgeCostUsd: number | undefined;
  let unpriced = usage.costUsd === undefined || usage.tokens.cost?.partial ? 1 : 0;
  let priced = usage.costUsd === undefined ? 0 : 1;
  const { judging } = grading;
  const context: EvalGradeContext = {
    ...(judging.suiteJudge ? { judge: judging.suiteJudge } : {}),
    ...(judging.provider ? { judgeProvider: judging.provider } : {}),
    ...(judging.decision ? { judgeDecision: judging.decision } : {}),
    ...(judging.media ? { media: judging.media } : {}),
    traceparent: trialRecord.traceparent,
    traced: async (traced) => {
      for (const record of traced) {
        judgeRecords.push(record);
        const cost = recordCost(record);
        if (cost.usd !== undefined) {
          judgeCostUsd = (judgeCostUsd ?? 0) + cost.usd;
          priced += 1;
        }
        if (!cost.whole) unpriced += 1;
        const policy = judging.policies.get(recordAgent(record) ?? '');
        if (grading.sink && policy) await writeTrace(grading.sink, Promise.resolve(record), policy);
      }
    },
    ...(grading.signal ? { signal: grading.signal } : {}),
  };
  const graded = await gradeTrial(grading.suite.suite.graders, trial, context);
  const results = graded.map((entry) => entry.result);
  const built = await trialRecord.finish(graded);
  grading.trialSpans.push(built.span);
  if (grading.sink) await writeTrace(grading.sink, Promise.resolve(built.record), grading.policy);
  const { costUsd } = usage;
  return {
    ...(evalCase ? { case: evalCase } : {}),
    index,
    outcome: trialOutcome(results),
    results,
    traceId: trial.root.traceId,
    turn: {
      durationMs: spanDurationMs(trial.top),
      modelCalls: modelCalls(trial).length,
      toolCalls: trial.spans('execute_tool').length,
      ...(typeof trial.root.attributes['theorem.stop.kind'] === 'string'
        ? { stop: trial.root.attributes['theorem.stop.kind'] }
        : {}),
    },
    records,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(judgeCostUsd === undefined ? {} : { judgeCostUsd }),
    unpriced,
    priced,
    judgeRecords,
    trialRecord: built.record,
  };
}

async function turnRequest(
  suite: LoadedSuite,
  evalCase: EvalCase,
  index: number,
): Promise<TurnRequest> {
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
      ...(evalCase.input.attachments
        ? {
            attachments: await Promise.all(
              evalCase.input.attachments.map(async (attachment) => ({
                mimeType: attachment.mimeType,
                data: await attachmentData(attachment),
                ...(attachment.name === undefined ? {} : { name: attachment.name }),
              })),
            ),
          }
        : {}),
    },
    metadata: { eval: stamp },
  };
}

async function runLiveTrial(
  grading: Grading,
  provider: ProviderHostOptions,
  evalCase: EvalCase,
  index: number,
  signal: AbortSignal | undefined,
): Promise<TrialReport> {
  const records: TraceRecord[] = [];
  let thrown: unknown;
  try {
    const request = {
      ...(await turnRequest(grading.suite, evalCase, index)),
      ...(signal ? { signal } : {}),
    };
    for await (const _event of runTurn(request, provider, memorySink(records))) {
      // why: The trace is the record of the turn; events are not graded.
    }
  } catch (error) {
    thrown = error;
  }
  if (records.length > 0) {
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
    unpriced: 0,
    priced: 0,
    judgeRecords: [],
    error,
  };
}

function judgingOf(loaded: LoadedSuite, options: RunSuiteOptions): Judging {
  const { suite } = loaded;
  const provider = options.judgeProvider ?? loaded.judgeProvider ?? options.provider;
  const decision = options.judgeDecision ?? loaded.judgeDecision;
  const media = options.media ?? loaded.media;
  const policies = new Map<string, ResolvedObservabilityPolicy>();
  for (const grader of suite.graders) {
    for (const id of grader.judgeProfiles?.(suite.judge?.profile) ?? []) {
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
  }
  return {
    ...(suite.judge ? { suiteJudge: suite.judge.profile } : {}),
    ...(provider ? { provider } : {}),
    ...(decision ? { decision } : {}),
    ...(media ? { media } : {}),
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

function reportCost(report: TrialReport): number {
  return (report.costUsd ?? 0) + (report.judgeCostUsd ?? 0);
}

interface Ran {
  byCase: Map<string, TrialReport[]>;
  caseless: TrialReport[];
  stopped?: 'budget';
  costUsd: number;
  unpriced: number;
  priced: number;
  skipped?: { judge: number; other: number };
}

function summedCost(reports: TrialReport[]): number {
  return reports.reduce((sum, report) => sum + reportCost(report), 0);
}

function summedCalls(reports: TrialReport[], key: 'unpriced' | 'priced'): number {
  return reports.reduce((sum, report) => sum + report[key], 0);
}

async function gradeRecorded(grading: Grading, records: TraceRecord[]): Promise<Ran> {
  const byCase = new Map<string, TrialReport[]>();
  const caseless: TrialReport[] = [];
  const cases = new Map(grading.suite.cases.map((evalCase) => [evalCase.id, evalCase]));
  const skipped = { judge: 0, other: 0 };
  for (const [, group] of groupByTrace(records)) {
    const traceRecords = group.filter((record) => !isJudgeStamp(record));
    skipped.judge += group.length - traceRecords.length;
    if (traceRecords.length === 0) continue;
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
  return {
    byCase,
    caseless,
    costUsd: summedCost(reports),
    unpriced: summedCalls(reports, 'unpriced'),
    priced: summedCalls(reports, 'priced'),
    skipped,
  };
}

/** The cost ceiling is checked before each start, so a stop lets what is in flight finish and count. */
async function runLive(
  grading: Grading,
  provider: ProviderHostOptions,
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
  const all = [...byCase.values()].flat();
  return {
    byCase,
    caseless: [],
    ...(stopped ? { stopped } : {}),
    costUsd,
    unpriced: summedCalls(all, 'unpriced'),
    priced: summedCalls(all, 'priced'),
  };
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

/** Runs every case of a suite and returns the graded run. */
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
      `skipped ${ran.skipped.judge} judge call record(s) and ${ran.skipped.other} record(s) with no turn; they are not trials`,
    );
  }
  if (options.maxCostUsd !== undefined && ran.unpriced > 0) {
    warnings.push(
      `maxCostUsd counts only the costs providers report; ${ran.unpriced} call(s) reported none or only part, so the ceiling could not hold them`,
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
  const decided = verdicts.filter((verdict) => verdict.decided);
  const undecided = verdicts.length - decided.length;
  if (undecided > 0) {
    warnings.push(
      `${undecided} case(s) undecided: too few of their trials escaped error to apply the pass rule, so no pass rate counts them`,
    );
  }
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
    passRule: rule,
    verdicts,
    trials,
    caseless: ran.caseless,
    passed:
      ran.stopped === undefined && decided.length > 0 && decided.every((verdict) => verdict.passed),
    ...(ran.stopped ? { stopped: ran.stopped } : {}),
    costUsd: ran.costUsd,
    unpriced: ran.unpriced,
    priced: ran.priced,
    warnings,
    run,
  };
}

export type { EvalStamp, RunSuiteOptions, SuiteRun, TrialReport, TurnShape };
export { runSuite };
