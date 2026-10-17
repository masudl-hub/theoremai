/**
 * Evals over traces: graders read the v3 `TraceRecord` and nothing else; results are trace records too, written through the same `TraceSink`.
 *
 * @module
 */

export { attachmentData } from './attachments.ts';
export type { GroupSummary, Spread } from './breakdown.ts';
export { groupSummaries } from './breakdown.ts';
export type { AnswerLabel, AnswerSource } from './graders/answer.ts';
export { answer } from './graders/answer.ts';
export type { BudgetOptions, DeliveredGraders, TrajectoryMode } from './graders/code.ts';
export { budget, delivered, guardrail, outcome, stopKind, toolTrajectory } from './graders/code.ts';
export type { JudgeOptions, Judgment } from './graders/judge.ts';
export { EVAL_JUDGMENT, judge } from './graders/judge.ts';
export { turnLatency } from './graders/latency.ts';
export type { TranscriptionGraders } from './graders/live.ts';
export { interruptions, transcription } from './graders/live.ts';
export { TRIAL_VARIABLES, trialVariables } from './graders/transcript.ts';
export type {
  GradedResult,
  OpenTrialRecord,
  RunRecordInput,
  TrialRecordInput,
} from './record.ts';
export { buildRunRecord, startTrialRecord } from './record.ts';
export type { EvalRubric, EvalRubricQuestion } from './rubrics/mod.ts';
export { fillRubric, rubric, rubrics } from './rubrics/mod.ts';
export type { EvalStamp, RunSuiteOptions, SuiteRun, TrialReport, TurnShape } from './run.ts';
export { runSuite } from './run.ts';
export type { LoadedSuite } from './suite.ts';
export { loadSuite, readJsonl, readTraceRecords } from './suite.ts';
export type { RunSummary, TrialSummary } from './summary.ts';
export { summarizeRun } from './summary.ts';
export { buildTrial, groupByTrace, hasTurn } from './trial.ts';
export type {
  EvalAnswer,
  EvalAttachment,
  EvalCase,
  EvalCaseInput,
  EvalCaseKind,
  EvalDifficulty,
  EvalExpect,
  EvalFileAttachment,
  EvalGradeContext,
  EvalGrader,
  EvalInlineAttachment,
  EvalMediaRef,
  EvalMediaResolver,
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
