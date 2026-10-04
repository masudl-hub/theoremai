/**
 * The judged example suite: the translator cases, graded by code and by a
 * text judge reading the correctness rubric. `scripts/evals-example.ts --judge
 * text` runs it live with a Gemini judge; the CLI test runs it with a
 * scripted one. `jev.ts` grades the same rubric with Jev, `both.ts` with both.
 */

import '../translator/profile.ts';
import './profile.ts';
import { delivered, stopKind } from '../../../src/evals/graders/code.ts';
import { judge } from '../../../src/evals/graders/judge.ts';
import { rubrics } from '../../../src/evals/rubrics/mod.ts';
import type { EvalSuite } from '../../../src/evals/types.ts';
import { TRANSLATOR } from '../translator/profile.ts';
import { JUDGE } from './profile.ts';

const suite: EvalSuite = {
  id: 'translator.judged.v1',
  profile: TRANSLATOR,
  mode: 'turn',
  cases: '../translator/cases.jsonl',
  trials: { repeat: 3 },
  graders: [delivered.json(), stopKind('completed'), judge({ rubric: rubrics.correctness })],
  judge: { profile: JUDGE },
};

export default suite;
