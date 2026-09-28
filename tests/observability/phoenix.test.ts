/**
 * Phoenix span annotations: each eval result on a trial span becomes one
 * annotation on the span the trial judged, as `/v1/span_annotations` takes
 * it. A judge's result is an LLM annotation, a code grader's a CODE one; an
 * errored result keeps its error in the metadata; other records add nothing.
 */

import { buildTrialRecord } from '../../src/evals/record.ts';
import { buildTrial } from '../../src/evals/trial.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { sha256 } from '../../src/kernel/engine/hash.ts';
import { phoenixAnnotations } from '../../src/observability/phoenix.ts';
import { CASE, POLICY, turnRecord } from '../evals/fixture.ts';

Deno.test('every trial result becomes an annotation on the judged root', async () => {
  const turn = await turnRecord({ text: 'hola' });
  const trial = buildTrial({ suite: 'translator.v1', case: CASE, index: 1, records: [turn] });
  const { record } = await buildTrialRecord({
    trial,
    policy: POLICY,
    results: [
      {
        result: {
          name: 'correctness',
          source: 'model',
          score: { value: 1, label: 'correct' },
          explanation: 'Jev chose correct with 93% confidence (correct 93%, incorrect 7%).',
          passed: true,
        },
        graderIdentity: 'judge:correctness',
      },
      {
        result: {
          name: 'delivered.includes',
          source: 'code',
          score: { value: 0, label: 'fail' },
          passed: false,
        },
        graderIdentity: 'code:delivered.includes',
      },
      {
        result: { name: 'faithfulness', source: 'model', errorType: 'rate_limit' },
        graderIdentity: 'judge:faithfulness',
      },
    ],
  });
  const annotations = phoenixAnnotations([turn, record]);
  assertEquals(annotations, [
    {
      span_id: trial.root.spanId,
      name: 'correctness',
      annotator_kind: 'LLM',
      result: {
        label: 'correct',
        score: 1,
        explanation: 'Jev chose correct with 93% confidence (correct 93%, incorrect 7%).',
      },
      metadata: {
        suite: 'translator.v1',
        case: CASE.id,
        trial: 1,
        passed: true,
        grader_version: await sha256('judge:correctness'),
      },
    },
    {
      span_id: trial.root.spanId,
      name: 'delivered.includes',
      annotator_kind: 'CODE',
      result: { label: 'fail', score: 0 },
      metadata: {
        suite: 'translator.v1',
        case: CASE.id,
        trial: 1,
        passed: false,
        grader_version: await sha256('code:delivered.includes'),
      },
    },
    {
      span_id: trial.root.spanId,
      name: 'faithfulness',
      annotator_kind: 'LLM',
      result: {},
      metadata: {
        suite: 'translator.v1',
        case: CASE.id,
        trial: 1,
        error_type: 'rate_limit',
        grader_version: await sha256('judge:faithfulness'),
      },
    },
  ]);
  // A turn record carries no trial span, so it adds nothing.
  assertEquals(phoenixAnnotations([turn]), []);
});
