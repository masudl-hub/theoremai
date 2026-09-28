/**
 * Evals over traces. A host says, for any profile: here are the cases, here is
 * what "good" means, run it k times and tell me, from the trace alone, whether
 * it passed. Graders read the v3 `TraceRecord` and nothing else; results are
 * trace records too, written through the same `TraceSink`.
 *
 * Hosts own the cases, the judge (a text model, Jev, or both) and the pass
 * rule. THEOREM owns the runner, the code graders and the result record;
 * viewing, labelling and comparing runs belong to the trace tool the host
 * already uses.
 *
 * @module
 */

export type { BudgetOptions, DeliveredGraders, TrajectoryMode } from './graders/code.ts';
export { budget, delivered, guardrail, outcome, stopKind, toolTrajectory } from './graders/code.ts';
export type { JudgeOptions, Judgment } from './graders/judge.ts';
export { EVAL_JUDGMENT, judge } from './graders/judge.ts';
export { turnLatency } from './graders/latency.ts';
export type { TranscriptionGraders } from './graders/live.ts';
export { interruptions, transcription } from './graders/live.ts';
export { TRIAL_VARIABLES, trialVariables } from './graders/transcript.ts';
export type { GradedResult, RunRecordInput, TrialRecordInput } from './record.ts';
export { buildRunRecord, buildTrialRecord } from './record.ts';
export type { EvalRubric, EvalRubricQuestion } from './rubrics/mod.ts';
export { fillRubric, rubric, rubrics } from './rubrics/mod.ts';
export type { RunSuiteOptions, SuiteRun, TrialReport } from './run.ts';
export { runSuite } from './run.ts';
export type { LoadedSuite } from './suite.ts';
export { loadSuite, readJsonl, readTraceRecords } from './suite.ts';
export type { RunSummary, TrialSummary } from './summary.ts';
export { summarizeRun } from './summary.ts';
export { buildTrial, groupByTrace } from './trial.ts';
export type {
  EvalAttachment,
  EvalCase,
  EvalCaseInput,
  EvalCaseKind,
  EvalDifficulty,
  EvalExpect,
  EvalGradeContext,
  EvalGrader,
  EvalPassRule,
  EvalResult,
  EvalResultSource,
  EvalSessionInput,
  EvalSessionStep,
  EvalSuite,
  EvalTrials,
  EvalTurnInput,
  TraceOperation,
  Trial,
  TrialMessage,
  TrialUsage,
} from './types.ts';
export { evalCaseSchema, evalResultSchema, evalSuiteSchema } from './types.ts';
export type { CaseVerdict, TrialOutcome } from './verdict.ts';
export { caseVerdict, passRuleName, trialOutcome } from './verdict.ts';
