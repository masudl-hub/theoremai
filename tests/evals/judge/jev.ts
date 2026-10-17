/**
 * The judged example suite with Jev as its judge: the correctness rubric's
 * question, answered by a decision profile. The host supplies the key in vault slot
 * `jev` through `judgeDecision`; `scripts/evals-example.ts --judge jev` reads it
 * from `TYPESAFE_API_KEY`.
 */

import '../translator/profile.ts';
import './profile.ts';
import { delivered, stopKind } from '../../../src/evals/graders/code.ts';
import { judge } from '../../../src/evals/graders/judge.ts';
import { rubrics } from '../../../src/evals/rubrics/mod.ts';
import type { EvalSuite } from '../../../src/evals/types.ts';
import { TRANSLATOR } from '../translator/profile.ts';
import { JEV_JUDGE } from './profile.ts';

const suite: EvalSuite = {
  id: 'translator.jev.v1',
  profile: TRANSLATOR,
  mode: 'turn',
  cases: '../translator/cases.jsonl',
  trials: { repeat: 3 },
  graders: [delivered.json(), stopKind('completed'), judge({ rubric: rubrics.correctness })],
  judge: { profile: JEV_JUDGE },
};

export default suite;
