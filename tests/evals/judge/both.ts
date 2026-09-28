/**
 * The judged example suite with both judges: Jev answers the correctness
 * rubric's question, and when it is unsure (the pass label short of more
 * likely than not, and no majority against it) the text judge decides. One
 * result per trial, linking every judge trace it drew on.
 */

import '../translator/profile.ts';
import './profile.ts';
import { delivered, stopKind } from '../../../src/evals/graders/code.ts';
import { judge } from '../../../src/evals/graders/judge.ts';
import { rubrics } from '../../../src/evals/rubrics/mod.ts';
import type { EvalSuite } from '../../../src/evals/types.ts';
import { TRANSLATOR } from '../translator/profile.ts';
import { JEV_JUDGE, JUDGE } from './profile.ts';

const suite: EvalSuite = {
  id: 'translator.both.v1',
  profile: TRANSLATOR,
  mode: 'turn',
  cases: '../translator/cases.jsonl',
  trials: { repeat: 3 },
  graders: [
    delivered.json(),
    stopKind('completed'),
    judge({ rubric: rubrics.correctness, profile: JEV_JUDGE, escalate: JUDGE }),
  ],
};

export default suite;
