import type { EvalCase, EvalPassRule, EvalResult } from './types.ts';

type TrialOutcome = 'passed' | 'failed' | 'errored' | 'ungraded';

function trialOutcome(results: readonly EvalResult[]): TrialOutcome {
  if (results.some((result) => result.errorType !== undefined)) return 'errored';
  const decided = results.filter((result) => result.passed !== undefined);
  if (decided.length === 0) return 'ungraded';
  return decided.every((result) => result.passed) ? 'passed' : 'failed';
}

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

function passRuleName(rule: EvalPassRule): 'all' | 'any' | 'at_least' {
  return typeof rule === 'string' ? rule : 'at_least';
}

// An errored trial is one that could not be graded (a provider error, a judge that failed), so the rule reads it as a trial that never ran: a rate limit never counts against the agent.
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
