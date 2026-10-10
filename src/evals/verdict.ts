import type { EvalCase, EvalPassRule, EvalResult } from './types.ts';

/** How a trial ended: passed, failed, errored or ungraded. */
type TrialOutcome = 'passed' | 'failed' | 'errored' | 'ungraded';

/** The outcome of a trial from its results. */
function trialOutcome(results: readonly EvalResult[]): TrialOutcome {
  if (results.some((result) => result.errorType !== undefined)) return 'errored';
  const decided = results.filter((result) => result.passed !== undefined);
  if (decided.length === 0) return 'ungraded';
  return decided.every((result) => result.passed) ? 'passed' : 'failed';
}

/** A case's verdict across its trials, under the pass rule. */
interface CaseVerdict {
  case: string;
  kind: EvalCase['kind'];
  difficulty?: EvalCase['difficulty'];
  passed: boolean;
  decided: boolean;
  trials: number;
  trialsPassed: number;
  trialsErrored: number;
  trialsUngraded: number;
}

function ruleMet(rule: EvalPassRule, passed: number, trials: number): boolean {
  if (trials === 0) return false;
  if (rule === 'all') return passed === trials;
  if (rule === 'any') return passed >= 1;
  return passed >= rule.atLeast;
}

function trialsNeeded(rule: EvalPassRule): number {
  return typeof rule === 'object' ? rule.atLeast : 1;
}

/** The name of a pass rule, as the trace records it. */
function passRuleName(rule: EvalPassRule): 'all' | 'any' | 'at_least' {
  return typeof rule === 'string' ? rule : 'at_least';
}

// why: An errored trial is one that could not be graded (a provider error, a judge that failed), so the rule reads it as a trial that never ran: a rate limit never counts against the agent.
/** The verdict of a case from its trials' results. */
function caseVerdict(
  evalCase: EvalCase,
  trials: readonly (readonly EvalResult[])[],
  rule: EvalPassRule = 'all',
): CaseVerdict {
  const outcomes = trials.map(trialOutcome);
  const count = (outcome: TrialOutcome) => outcomes.filter((o) => o === outcome).length;
  const trialsPassed = count('passed');
  const trialsErrored = count('errored');
  const trialsUngraded = count('ungraded');
  const ran = outcomes.length - trialsErrored;
  const passed = trialsUngraded < ran && ruleMet(rule, trialsPassed, ran);
  return {
    case: evalCase.id,
    kind: evalCase.kind,
    ...(evalCase.difficulty === undefined ? {} : { difficulty: evalCase.difficulty }),
    passed,
    decided: passed || trialsErrored === 0 || ran >= trialsNeeded(rule),
    trials: outcomes.length,
    trialsPassed,
    trialsErrored,
    trialsUngraded,
  };
}

export type { CaseVerdict, TrialOutcome };
export { caseVerdict, passRuleName, trialOutcome };
