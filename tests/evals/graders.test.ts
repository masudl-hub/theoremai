/**
 * Code graders over a synthetic turn: each reads the trace and nothing else,
 * and grading the same records twice gives byte-identical results.
 */

import {
  budget,
  delivered,
  guardrail,
  outcome,
  stopKind,
  toolTrajectory,
} from '../../src/evals/graders/code.ts';
import { turnLatency } from '../../src/evals/graders/latency.ts';
import { interruptions, transcription } from '../../src/evals/graders/live.ts';
import { buildTrial } from '../../src/evals/trial.ts';
import type { EvalCase, EvalGradeContext, EvalGrader, Trial } from '../../src/evals/types.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import type { TraceRecord } from '../../src/observability/trace-record.ts';
import { CASE, liveRecord, type TurnFixtureOptions, turnRecord } from './fixture.ts';

/** Code graders take no judge. */
const NO_JUDGE: EvalGradeContext = { traced: () => undefined };

async function trialOf(options: TurnFixtureOptions, evalCase: EvalCase = CASE): Promise<Trial> {
  return buildTrial({ suite: 's', case: evalCase, index: 0, records: [await turnRecord(options)] });
}

async function passes(grader: EvalGrader, trial: Trial): Promise<boolean | undefined> {
  return (await grader.grade(trial, NO_JUDGE)).passed;
}

Deno.test('delivered text graders read the model’s own words', async () => {
  const trial = await trialOf({ text: 'La tetera está encendida.' });
  assertEquals(await passes(delivered.includes('tetera'), trial), true);
  assertEquals(await passes(delivered.includes('kettle'), trial), false);
  assertEquals(await passes(delivered.regex('^La .* encendida\\.$'), trial), true);
  assertEquals(await passes(delivered.equals('La tetera está encendida.'), trial), true);
  assertEquals(await passes(delivered.equals('La tetera'), trial), false);
  const result = await delivered.includes('kettle').grade(trial, NO_JUDGE);
  assertEquals(result, {
    name: 'delivered_includes',
    source: 'code',
    score: { value: 0, label: 'fail' },
    explanation: 'delivered text lacks "kettle"',
    passed: false,
  });
});

Deno.test('delivered JSON graders prefer the structured part and fall back to text', async () => {
  const schema = { type: 'object', required: ['lang', 'text'], properties: {} };
  const structured = await trialOf({ text: 'ignored', structured: { lang: 'es', text: 'hola' } });
  assertEquals(await passes(delivered.jsonSchema(schema), structured), true);
  assertEquals(await passes(delivered.json(), structured), true);
  const partial = await trialOf({ structured: { lang: 'fr' } });
  assertEquals(await passes(delivered.jsonSchema(schema), partial), false);
  const wrong = await delivered.json().grade(partial, NO_JUDGE);
  assertEquals(wrong.passed, false);
  assertEquals(wrong.explanation, 'fields differ: lang expected "es" got "fr"');
  const fromText = await trialOf({ text: '{"lang":"es","text":"hola"}' });
  assertEquals(await passes(delivered.json(), fromText), true);
  const prose = await trialOf({ text: 'hola' });
  assertEquals(
    (await delivered.jsonSchema(schema).grade(prose, NO_JUDGE)).explanation,
    'delivered output is not JSON',
  );
  const noExpect = await trialOf({ structured: { lang: 'es' } }, { ...CASE, expect: {} });
  assertEquals(
    (await delivered.json().grade(noExpect, NO_JUDGE)).explanation,
    'case has no expect.json',
  );
});

Deno.test('tool trajectory: exact, in_order, any_order and subset', async () => {
  const trial = await trialOf({ tools: ['lookup', 'book', 'lookup'] });
  const mode = (m: 'exact' | 'in_order' | 'any_order' | 'subset', expect: string[]) =>
    passes(toolTrajectory({ mode: m, expect }), trial);
  assertEquals(await mode('exact', ['lookup', 'book', 'lookup']), true);
  assertEquals(await mode('exact', ['lookup', 'book']), false);
  assertEquals(await mode('in_order', ['lookup', 'lookup']), true);
  assertEquals(await mode('in_order', ['book', 'book']), false);
  assertEquals(await mode('any_order', ['book', 'lookup', 'lookup']), true);
  assertEquals(await mode('any_order', ['book', 'lookup']), false);
  assertEquals(await mode('subset', ['lookup', 'book', 'cancel']), true);
  assertEquals(await mode('subset', ['lookup']), false);
});

Deno.test('tool trajectory reads the case when no expectation is given', async () => {
  const none = await trialOf({});
  const grader = toolTrajectory({ mode: 'subset' });
  assertEquals(grader.needsExpect, true);
  assertEquals(await passes(grader, none), true);
  const called = await trialOf({ tools: ['lookup'] });
  const result = await grader.grade(called, NO_JUDGE);
  assertEquals(result.passed, false);
  assertEquals(result.explanation, 'called lookup; expected none (subset)');
  const caseless = buildTrial({ suite: 's', index: 0, records: [await turnRecord()] });
  assertEquals((await grader.grade(caseless, NO_JUDGE)).explanation, 'case has no expect.tools');
});

Deno.test('stop kind and guardrail read the root', async () => {
  assertEquals(await passes(stopKind('completed'), await trialOf({})), true);
  assertEquals(await passes(stopKind(['length', 'tool']), await trialOf({})), false);
  assertEquals(await passes(stopKind('length'), await trialOf({ stop: 'length' })), true);
  const blocked = await trialOf({ guardrailAction: 'block' });
  const allowed = await trialOf({ guardrailAction: 'allow' });
  assertEquals(await passes(guardrail({ fired: true }), blocked), true);
  assertEquals(await passes(guardrail({ fired: true }), allowed), false);
  assertEquals(await passes(guardrail({ fired: false }), allowed), true);
  assertEquals(await passes(guardrail({ fired: true, action: 'redact' }), blocked), false);
  assertEquals(
    (await guardrail({ fired: false }).grade(blocked, NO_JUDGE)).explanation,
    'guardrail acted: block',
  );
});

Deno.test('budget names every ceiling crossed, and one the trace cannot show', async () => {
  const trial = await trialOf({ costUsd: 0.05, timeToFirstChunk: 1.5, durationMs: 300 });
  assertEquals(
    await passes(
      budget({
        maxCostUsd: 0.1,
        maxTokens: 100,
        maxSteps: 1,
        maxDurationMs: 500,
        maxTimeToFirstChunkMs: 2000,
      }),
      trial,
    ),
    true,
  );
  const over = await budget({ maxCostUsd: 0.01, maxTokens: 50, maxTimeToFirstChunkMs: 1000 }).grade(
    trial,
    NO_JUDGE,
  );
  assertEquals(over.passed, false);
  assertEquals(
    over.explanation,
    'maxCostUsd: 0.05 over 0.01; maxTokens: 52 over 50; maxTimeToFirstChunkMs: 1500 over 1000',
  );
  const free = await trialOf({});
  assertEquals(
    (await budget({ maxCostUsd: 1 }).grade(free, NO_JUDGE)).explanation,
    'maxCostUsd: not recorded',
  );
});

Deno.test('outcome is the host’s check: a boolean or a full result', async () => {
  const trial = await trialOf({});
  assertEquals(
    await passes(
      outcome('booked', () => true),
      trial,
    ),
    true,
  );
  const scored = await outcome('booked', () => ({
    name: 'booked',
    source: 'code',
    score: { value: 0.5 },
    explanation: 'half done',
  })).grade(trial, NO_JUDGE);
  assertEquals(scored.passed, undefined);
  assertEquals(scored.score, { value: 0.5 });
});

Deno.test('live graders read transcripts and interrupted stops, not the model text', async () => {
  const trial = await trialOf({ text: 'hello there' });
  assertEquals(await passes(transcription.includes('hello'), trial), false);
  assertEquals(await passes(interruptions({ max: 0 }), trial), true);
  const scripted: EvalCase = { ...CASE, expect: { transcription: { regex: '(?:hello|hi)' } } };
  const graded = await transcription.regex().grade(await trialOf({}, scripted), NO_JUDGE);
  assertEquals(graded.explanation, 'transcript does not match /(?:hello|hi)/');
  assertEquals(transcription.regex().needsExpect, true);
  assertEquals(transcription.regex('hi').needsExpect, false);
});

Deno.test('grading the same records twice is byte-identical', async () => {
  const records: TraceRecord[] = [
    await turnRecord({ text: 'hola', tools: ['lookup'], costUsd: 0.01 }),
  ];
  const graders = [
    delivered.includes('hola'),
    toolTrajectory({ mode: 'exact', expect: ['lookup'] }),
    budget({ maxCostUsd: 0.02 }),
    stopKind('completed'),
  ];
  const grade = async () => {
    const trial = buildTrial({ suite: 's', case: CASE, index: 0, records });
    return JSON.stringify(
      await Promise.all(graders.map((grader) => grader.grade(trial, NO_JUDGE))),
    );
  };
  assertEquals(await grade(), await grade());
});

Deno.test('a grader’s identity names exactly what it checks', () => {
  assertEquals(delivered.includes('x').identity, 'delivered.includes:x');
  assertEquals(toolTrajectory({ mode: 'subset' }).identity, 'toolTrajectory:subset:case');
  assertEquals(budget({ maxSteps: 3 }).identity, 'budget:{"maxSteps":3}');
  assertEquals(guardrail({ fired: false }).identity, 'guardrail:false:any');
});

Deno.test('turn latency is the person’s whole wait: turn start through a retry to the first chunk', async () => {
  // 50 ms before the call, a 503 try of 200 ms, then 10 ms + 0.3 s to the first chunk.
  const trial = await trialOf({ beforeChatMs: 50, retryAfterMs: 200, timeToFirstChunk: 0.3 });
  const result = await turnLatency({ maxMs: 600 }).grade(trial, NO_JUDGE);
  assertEquals(result.passed, true);
  assertEquals(result.explanation, 'reply began after 550 ms');
  assertEquals(
    (await turnLatency({ maxMs: 500 }).grade(trial, NO_JUDGE)).explanation,
    'reply: 550 ms over 500',
  );
  // The provider's own share is shorter: budget reads the try, not the wait.
  assertEquals(await passes(budget({ maxTimeToFirstChunkMs: 300 }), trial), true);
  assertEquals(
    (await turnLatency({ maxMs: 1000 }).grade(await trialOf({}), NO_JUDGE)).explanation,
    'reply: first chunk not recorded',
  );
});

Deno.test('Live latency runs from the end of speech, or from the text step, to each reply’s first chunk', async () => {
  const session = await liveRecord([
    { speechEndsAfterMs: 100, sentAfterMs: 20, timeToFirstChunk: 0.5, transcript: 'Hello!' },
    { sentAfterMs: 30, timeToFirstChunk: 0.25, transcript: 'Bye.' },
    { speechEndsAfterMs: 60, sentAfterMs: 10, timeToFirstChunk: 0.1, transcript: 'Ok.' },
  ]);
  const trial = buildTrial({ suite: 's', index: 0, records: [session] });
  // 20 + 500 from the speech end; 250 from the text step (earlier speech never anchors it); 10 + 100.
  const result = await turnLatency({ maxMs: 600 }).grade(trial, NO_JUDGE);
  assertEquals(result.passed, true);
  assertEquals(result.explanation, '3 replies began within 520 ms');
  assertEquals(
    (await turnLatency({ maxMs: 200 }).grade(trial, NO_JUDGE)).explanation,
    'reply 1: 520 ms over 200; reply 2: 250 ms over 200',
  );
  const silent = await liveRecord([{ transcript: 'Hi' }]);
  assertEquals(
    (
      await turnLatency({ maxMs: 300 }).grade(
        buildTrial({ suite: 's', index: 0, records: [silent] }),
        NO_JUDGE,
      )
    ).explanation,
    'reply: first chunk not recorded',
  );
  assertEquals(turnLatency({ maxMs: 300 }).identity, 'turnLatency:300');
});
