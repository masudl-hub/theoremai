/**
 * The example suite: four translation cases, three trials each, graded from
 * the trace alone. `agents eval tests/evals/translator/suite.ts --recorded
 * <dir>` grades traces a host already has; `scripts/evals-example.ts` runs it
 * live with a real provider.
 */

import './profile.ts';
import { budget, delivered, stopKind, toolTrajectory } from '../../../src/evals/graders/code.ts';
import { turnLatency } from '../../../src/evals/graders/latency.ts';
import type { EvalSuite } from '../../../src/evals/types.ts';
import { TRANSLATOR } from './profile.ts';

const suite: EvalSuite = {
  id: 'translator.v1',
  profile: TRANSLATOR,
  mode: 'turn',
  cases: './cases.jsonl',
  trials: { repeat: 3 },
  graders: [
    delivered.json(),
    toolTrajectory({ mode: 'exact' }),
    stopKind('completed'),
    // No cost ceiling: Gemini reports no charge, and a ceiling the trace cannot show fails.
    budget({ maxSteps: 1, maxDurationMs: 20_000 }),
    turnLatency({ maxMs: 8_000 }),
  ],
};

export default suite;
