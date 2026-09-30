/**
 * Pass rules: the same three trials read as fail under `all`, pass under
 * `any`, pass under `{ atLeast: 2 }`; an errored trial is one that never ran;
 * nothing is lost.
 */

import type { EvalResult } from '../../src/evals/types.ts';
import { caseVerdict, trialOutcome } from '../../src/evals/verdict.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { CASE } from './fixture.ts';

const pass: EvalResult = { name: 'g', source: 'code', passed: true };
const fail: EvalResult = { name: 'g', source: 'code', passed: false };
const info: EvalResult = { name: 'g', source: 'model', score: { value: 0.7 } };
const errored: EvalResult = { name: 'g', source: 'code', errorType: 'grader_error' };

const TWO_OF_THREE = [[pass], [pass], [fail]];

Deno.test('a trial passes when every deciding grader passed', () => {
  assertEquals(trialOutcome([pass, pass]), 'passed');
  assertEquals(trialOutcome([pass, fail]), 'failed');
  assertEquals(trialOutcome([pass, info]), 'passed');
  assertEquals(trialOutcome([info]), 'ungraded');
  assertEquals(trialOutcome([]), 'ungraded');
  assertEquals(trialOutcome([pass, errored]), 'errored');
});

Deno.test('two of three trials: fails under all, passes under any and at-least-2', () => {
  assertEquals(caseVerdict(CASE, TWO_OF_THREE, 'all').passed, false);
  assertEquals(caseVerdict(CASE, TWO_OF_THREE, 'any').passed, true);
  assertEquals(caseVerdict(CASE, TWO_OF_THREE, { atLeast: 2 }).passed, true);
  assertEquals(caseVerdict(CASE, TWO_OF_THREE, { atLeast: 3 }).passed, false);
  assertEquals(caseVerdict(CASE, TWO_OF_THREE).passed, false);
});

Deno.test('the verdict keeps every count, zeros included', () => {
  assertEquals(caseVerdict(CASE, [[pass], [errored], [info]], 'any'), {
    case: 'es-01',
    kind: 'regression',
    passed: true,
    decided: true,
    trials: 3,
    trialsPassed: 1,
    trialsErrored: 1,
    trialsUngraded: 1,
  });
  assertEquals(caseVerdict({ ...CASE, difficulty: 4 }, [[pass]]).difficulty, 4);
});

Deno.test('a case whose trials were all ungraded does not pass', () => {
  const verdict = caseVerdict(CASE, [[info], [info]], 'any');
  assertEquals(verdict.passed, false);
  assertEquals(verdict.trialsUngraded, 2);
  assertEquals(caseVerdict(CASE, []).passed, false);
});

Deno.test('an errored trial never counts against the case: the rule reads the trials that ran', () => {
  const verdict = (trials: EvalResult[][], rule?: Parameters<typeof caseVerdict>[2]) => {
    const { passed, decided } = caseVerdict(CASE, trials, rule);
    return { passed, decided };
  };
  // pass^k over the one trial a rate limit spared.
  assertEquals(verdict([[pass], [errored], [errored]]), { passed: true, decided: true });
  assertEquals(verdict([[fail], [errored], [errored]]), { passed: false, decided: true });
  // Every trial errored: nothing to read, so neither pass nor fail.
  assertEquals(verdict([[errored], [errored]]), { passed: false, decided: false });
  assertEquals(verdict([[errored], [errored]], 'any'), { passed: false, decided: false });
  // At least 2 needs two trials that ran; one met is not yet a fail.
  assertEquals(verdict([[pass], [errored], [errored]], { atLeast: 2 }), {
    passed: false,
    decided: false,
  });
  assertEquals(verdict([[pass], [pass], [errored]], { atLeast: 2 }), {
    passed: true,
    decided: true,
  });
  // No trials at all is a failure, not an error: nothing was lost to one.
  assertEquals(verdict([]), { passed: false, decided: true });
});
