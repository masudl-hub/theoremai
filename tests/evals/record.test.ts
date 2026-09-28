/**
 * Result records: the trial span lives in the judged trace under its root,
 * open for as long as grading runs so judge calls nest beneath it, one event
 * per result, every name in the catalog; the run record links every trial and
 * keeps every verdict.
 */

import { delivered, toolTrajectory } from '../../src/evals/graders/code.ts';
import { buildRunRecord, type GradedResult, startTrialRecord } from '../../src/evals/record.ts';
import { buildTrial } from '../../src/evals/trial.ts';
import type { EvalGradeContext, EvalGrader, Trial } from '../../src/evals/types.ts';
import { caseVerdict } from '../../src/evals/verdict.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { sha256 } from '../../src/kernel/engine/hash.ts';
import { contentOf } from '../../src/observability/trace-record.ts';
import { parseTraceparent } from '../../src/observability/trace-span.ts';
import { catalogedSink, catalogGate } from '../fixtures/trace-catalog.ts';
import { STUB_WRITE } from '../fixtures/trace-record.ts';
import { CASE, manualClock, POLICY, turnRecord } from './fixture.ts';

/** Code graders take no judge. */
const NO_JUDGE: EvalGradeContext = { traced: () => undefined };

function graded(graders: EvalGrader[], trial: Trial): Promise<GradedResult[]> {
  return Promise.all(
    graders.map(async (grader) => ({
      result: await grader.grade(trial, NO_JUDGE),
      graderIdentity: grader.identity,
    })),
  );
}

async function trialAndRecord(responseId?: string) {
  const turn = await turnRecord({ text: 'hola', responseId, metadata: { eval: { suite: 's' } } });
  const trial = buildTrial({ suite: 'translator.v1', case: CASE, index: 2, records: [turn] });
  const graders = [delivered.includes('hola'), toolTrajectory({ mode: 'subset' })];
  const results = await graded(graders, trial);
  const built = await startTrialRecord({ trial, policy: POLICY, clock: manualClock() }).finish(
    results,
  );
  await catalogedSink([]).write(built.record, STUB_WRITE);
  return { trial, results, ...built };
}

Deno.test('the trial span joins the judged trace under its root', async () => {
  const { trial, record, span } = await trialAndRecord();
  assertEquals(span.traceId, trial.root.traceId);
  assertEquals(span.parentSpanId, trial.root.spanId);
  assertEquals(span.name, 'theorem.eval.trial');
  assertEquals(record.spans.length, 1);
  assertEquals(record.metadata, { eval: { suite: 's' } });
  assertEquals(span.attributes['theorem.evaluation.suite'], 'translator.v1');
  assertEquals(span.attributes['theorem.evaluation.case'], 'es-01');
  assertEquals(span.attributes['theorem.evaluation.trial'], 2);
  assertEquals(span.status, { code: 'OK' });
});

Deno.test('one gen_ai.evaluation.result per grader, explanation stored by hash, version by identity', async () => {
  const { record, span, results } = await trialAndRecord('resp-7');
  assertEquals(
    span.events.map((event) => event.name),
    ['gen_ai.evaluation.result', 'gen_ai.evaluation.result'],
  );
  const [first] = span.events;
  assertEquals(first?.attributes['gen_ai.evaluation.name'], 'delivered_includes');
  assertEquals(first?.attributes['gen_ai.evaluation.score.value'], 1);
  assertEquals(first?.attributes['gen_ai.evaluation.score.label'], 'pass');
  assertEquals(first?.attributes['theorem.evaluation.source'], 'code');
  assertEquals(first?.attributes['theorem.evaluation.passed'], true);
  assertEquals(first?.attributes['gen_ai.response.id'], 'resp-7');
  assertEquals(
    first?.attributes['theorem.evaluation.grader.version'],
    await sha256(results[0]?.graderIdentity ?? ''),
  );
  assertEquals(
    contentOf(record, first?.attributes['gen_ai.evaluation.explanation']),
    'delivered text includes "hola"',
  );
});

Deno.test('no response id when the judged chat span reported none', async () => {
  const { span } = await trialAndRecord();
  assertEquals('gen_ai.response.id' in (span.events[0]?.attributes ?? {}), false);
});

Deno.test('judges run under the trial span, which lasts as long as grading', async () => {
  const turn = await turnRecord();
  const trial = buildTrial({ suite: 's', index: 0, records: [turn] });
  const clock = manualClock();
  const open = startTrialRecord({ trial, policy: POLICY, clock });
  clock.tickMs(1200);
  const { span } = await open.finish([]);
  assertEquals(parseTraceparent(open.traceparent), { traceId: span.traceId, spanId: span.spanId });
  assertEquals(Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)), 1.2e9);
  assertEquals(span.links, []);
});

Deno.test('an errored result marks the span', async () => {
  const turn = await turnRecord();
  const trial = buildTrial({ suite: 's', index: 0, records: [turn] });
  const judge = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
  const results: GradedResult[] = [
    {
      result: {
        name: 'faithfulness',
        source: 'model',
        errorType: 'grader_error',
        judgeTraceparents: [judge],
      },
      graderIdentity: 'judge:faithfulness',
    },
    {
      result: {
        name: 'faithfulness.strict',
        source: 'model',
        score: { value: 1, label: 'faithful' },
        judgeTraceparents: [judge],
      },
      graderIdentity: 'judge:faithfulness.strict',
    },
  ];
  const { record, span } = await startTrialRecord({ trial, policy: POLICY }).finish(results);
  await catalogedSink([]).write(record, STUB_WRITE);
  assertEquals(span.status, { code: 'ERROR', message: 'grader_error' });
  assertEquals(span.events[0]?.attributes['error.type'], 'grader_error');
  assertEquals(
    span.events[1]?.attributes['theorem.evaluation.grader.version'],
    await sha256('judge:faithfulness.strict'),
  );
  assertEquals('theorem.evaluation.case' in span.attributes, false);
});

Deno.test('the run record keeps every verdict and links every trial span', async () => {
  const a = await trialAndRecord();
  const b = await trialAndRecord();
  const verdicts = [
    caseVerdict(CASE, [a.results.map((g) => g.result), b.results.map((g) => g.result)], {
      atLeast: 2,
    }),
    caseVerdict({ ...CASE, id: 'es-02', kind: 'capability', difficulty: 5 }, [], { atLeast: 2 }),
  ];
  const record = await buildRunRecord({
    suite: { id: 'translator.v1', trials: { repeat: 2, pass: { atLeast: 2 } } },
    verdicts,
    trialSpans: [a.span, b.span],
    policy: POLICY,
    clock: manualClock(),
    revision: 'abc123',
  });
  await catalogedSink([]).write(record, STUB_WRITE);
  const [root] = record.spans;
  assertEquals(root?.name, 'theorem.eval.run');
  assertEquals(root?.parentSpanId, undefined);
  assertEquals(root?.attributes['theorem.eval.repeat'], 2);
  assertEquals(root?.attributes['theorem.eval.pass_rule'], 'at_least');
  assertEquals(root?.attributes['theorem.eval.pass_at_least'], 2);
  assertEquals(root?.attributes['vcs.ref.head.revision'], 'abc123');
  assertEquals(root?.status, { code: 'OK' });
  assertEquals(
    root?.links.map((link) => link.spanId),
    [a.span.spanId, b.span.spanId],
  );
  assertEquals(
    root?.events.map((event) => event.attributes),
    [
      {
        case: 'es-01',
        kind: 'regression',
        passed: true,
        trials: 2,
        trials_passed: 2,
        trials_errored: 0,
        trials_ungraded: 0,
      },
      {
        case: 'es-02',
        kind: 'capability',
        difficulty: 5,
        passed: false,
        trials: 0,
        trials_passed: 0,
        trials_errored: 0,
        trials_ungraded: 0,
      },
    ],
  );
});

Deno.test('a run stopped on budget is caseless-aware and not finished', async () => {
  const record = await buildRunRecord({
    suite: { id: 's', trials: { repeat: 1 } },
    verdicts: [],
    trialSpans: [],
    policy: POLICY,
    caseless: true,
    stopped: 'budget',
  });
  await catalogedSink([]).write(record, STUB_WRITE);
  const [root] = record.spans;
  assertEquals(root?.attributes['theorem.eval.pass_rule'], 'all');
  assertEquals(root?.attributes['theorem.eval.caseless'], true);
  assertEquals(root?.attributes['theorem.eval.stopped'], 'budget');
  assertEquals(root?.status, { code: 'UNSET' });
});

catalogGate();
