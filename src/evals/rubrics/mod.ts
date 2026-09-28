/**
 * The rubrics a `judge` grader can run: three ported from
 * `@arizeai/phoenix-evals` 2.5.0 (Apache License 2.0, Copyright Arize AI,
 * Inc.), each with THEOREM's own question for a decision judge, and
 * `rubric()` for a host's own. Phoenix itself holds the wider catalogue; a
 * host that wants another rubric writes it with `rubric()`.
 *
 * @module
 */

import { correctness } from './correctness.ts';
import { faithfulness } from './faithfulness.ts';
import { toolSelection } from './tool-selection.ts';
import type { EvalRubric } from './types.ts';

/** Every built-in rubric, by name. */
const rubrics = {
  correctness,
  faithfulness,
  toolSelection,
} as const satisfies Record<string, EvalRubric>;

export type { EvalRubric, EvalRubricQuestion } from './types.ts';
export { fillRubric, rubric } from './types.ts';
export { rubrics };
