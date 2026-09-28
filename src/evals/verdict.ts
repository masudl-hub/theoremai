/**
 * From results to a verdict. A trial passes when every grader that decided
 * said yes; a case passes when its trials meet the suite's pass rule. Nothing
 * is summarized away: every count is kept, zeros included.
 *
 * @module
 */

import type { EvalCase, EvalPassRule, EvalResult } from './types.ts';

/**
 * One trial's outcome. `errored`: a grader could not produce a result;
 * `ungraded`: no grader decided (results, if any, were informational only).
 */
type TrialOutcome = 'passed' | 'failed' | 'errored' | 'ungraded';

function trialOutcome(results: readonly EvalResult[]): TrialOutcome {
  if (results.some((result) => result.errorType !== undefined)) return 'errored';
  const decided = results.filter((result) => result.passed !== undefined);
  if (decided.length === 0) return 'ungraded';
  return decided.every((result) => result.passed) ? 'passed' : 'failed';
}

/** One case's verdict after k trials. */
interface CaseVerdict {
  case: string;
  kind: EvalCase['kind'];
  difficulty?: EvalCase['difficulty'];
  /** The pass rule, met or not. False when every trial was ungraded. */
  passed: boolean;
  trials: number;
  trialsPassed: number;
  trialsErrored: number;
  trialsUngraded: number;
}

/** Whether `passed` of `trials` meets the rule. */
function ruleMet(rule: EvalPassRule, passed: number, trials: number): boolean {
  if (trials === 0) return false;
  if (rule === 'all') return passed === trials;
  if (rule === 'any') return passed >= 1;
  return passed >= rule.atLeast;
}

/** The rule as the run record names it. */
function passRuleName(rule: EvalPassRule): 'all' | 'any' | 'at_least' {
  return typeof rule === 'string' ? rule : 'at_least';
}

/** A case's verdict from each trial's results, by the suite's pass rule (default `all`). */
function caseVerdict(
  evalCase: EvalCase,
  trials: readonly (readonly EvalResult[])[],
  rule: EvalPassRule = 'all',
): CaseVerdict {
  const outcomes = trials.map(trialOutcome);
  const count = (outcome: TrialOutcome) => outcomes.filter((o) => o === outcome).length;
  const trialsPassed = count('passed');
  const trialsUngraded = count('ungraded');
  return {
    case: evalCase.id,
    kind: evalCase.kind,
    ...(evalCase.difficulty === undefined ? {} : { difficulty: evalCase.difficulty }),
    passed: trialsUngraded < outcomes.length && ruleMet(rule, trialsPassed, outcomes.length),
    trials: outcomes.length,
    trialsPassed,
    trialsErrored: count('errored'),
    trialsUngraded,
  };
}

export type { CaseVerdict, TrialOutcome };
export { caseVerdict, passRuleName, trialOutcome };
