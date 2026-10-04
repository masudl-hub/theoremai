/**
 * Identification datasets: cases whose photos sit beside the cases file,
 * pinned by hash; the `answer` grader labelling a trial against the case's
 * accepted, partial and rejected names with no model, reading the reply, a JSON key or
 * a committing tool call's argument; and the run reported by tag.
 */

import { createHash } from 'node:crypto';
import { groupSummaries } from '../../src/evals/breakdown.ts';
import { answer } from '../../src/evals/graders/answer.ts';
import { runSuite, type TrialReport } from '../../src/evals/run.ts';
import { loadSuite } from '../../src/evals/suite.ts';
import { buildTrial } from '../../src/evals/trial.ts';
import type { EvalCase, EvalGradeContext, EvalResult, Trial } from '../../src/evals/types.ts';
import { caseVerdict } from '../../src/evals/verdict.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import { assertEquals, assertRejects } from '../../src/kernel/engine/assert.ts';
import { historyMessageParts } from '../../src/kernel/interaction-parts.ts';
import type { InteractionPart, ModelProvider } from '../../src/kernel/types.ts';
import { type TurnFixtureOptions, turnRecord } from './fixture.ts';

const NO_JUDGE: EvalGradeContext = { traced: () => undefined };

const POTHOS: EvalCase = {
  id: 'pothos-01',
  kind: 'capability',
  input: { text: 'what plant is this?' },
  expect: {
    answer: {
      accepted: ['Epipremnum aureum', 'golden pothos', "devil's ivy"],
      partial: ['Epipremnum'],
      reference: 'Variegated heart-shaped leaves, aerial roots.',
    },
  },
  tags: ['houseplant', 'photo'],
};

async function trialOf(options: TurnFixtureOptions, evalCase: EvalCase = POTHOS): Promise<Trial> {
  return buildTrial({ suite: 's', case: evalCase, index: 0, records: [await turnRecord(options)] });
}

async function labelOf(
  grader: ReturnType<typeof answer>,
  options: TurnFixtureOptions,
): Promise<[string | undefined, boolean | undefined, string | undefined]> {
  const result = await grader.grade(await trialOf(options), NO_JUDGE);
  return [result.score?.label, result.passed, result.explanation];
}

Deno.test('answer searches the reply for the case’s names as whole words', async () => {
  const reply = answer();
  assertEquals(await labelOf(reply, { text: 'That is a Golden Pothos!' }), [
    'accepted',
    true,
    'reply names "golden pothos"',
  ]);
  // Case, accents and punctuation do not matter: any apostrophe is punctuation, a missing one is a different word.
  assertEquals((await labelOf(reply, { text: 'DEVIL’S IVY' }))[0], 'accepted');
  assertEquals((await labelOf(reply, { text: 'Devils ivy, I think.' }))[0], 'wrong');
  assertEquals((await labelOf(reply, { text: "It's devil's  ivy." }))[0], 'accepted');
  assertEquals((await labelOf(reply, { text: 'Épipremnum aureum' }))[0], 'accepted');
  // The genus alone is close but not enough, and never a pass.
  assertEquals(await labelOf(reply, { text: 'Some Epipremnum species.' }), [
    'partial',
    false,
    'reply names "Epipremnum"; accepted Epipremnum aureum, golden pothos, devil\'s ivy',
  ]);
  // A name inside a longer word is not the name.
  assertEquals((await labelOf(reply, { text: 'Epipremnumaureum' }))[0], 'wrong');
  assertEquals(await labelOf(reply, { text: 'A Philodendron.' }), [
    'wrong',
    false,
    "reply names none of Epipremnum aureum, golden pothos, devil's ivy",
  ]);
});

Deno.test('a reply naming a rejected name beside the answer hedged; alone it is wrong', async () => {
  const confused: EvalCase = {
    ...POTHOS,
    expect: {
      answer: {
        accepted: ['Epipremnum aureum', 'golden pothos'],
        partial: ['Epipremnum'],
        rejected: ['Epipremnum pinnatum', 'Philodendron hederaceum'],
      },
    },
  };
  const label = async (text: string) => {
    const result = await answer().grade(await trialOf({ text }, confused), NO_JUDGE);
    return [result.score?.label, result.passed, result.explanation];
  };
  assertEquals(await label('Golden pothos, or possibly Epipremnum pinnatum.'), [
    'partial',
    false,
    'reply names "golden pothos" and "Epipremnum pinnatum", which the case rejects',
  ]);
  assertEquals(await label('A Philodendron hederaceum.'), [
    'wrong',
    false,
    'reply names "Philodendron hederaceum", which the case rejects; accepted Epipremnum aureum, golden pothos',
  ]);
  // The rejected name outranks the genus it shares with the answer.
  assertEquals((await label('Epipremnum pinnatum'))[0], 'wrong');
  assertEquals(await label('Epipremnum aureum.'), [
    'accepted',
    true,
    'reply names "Epipremnum aureum"',
  ]);
  // A name said only inside a longer listed one is not said.
  const zz: EvalCase = {
    ...POTHOS,
    expect: {
      answer: {
        accepted: ['Zamioculcas', 'ZZ plant'],
        rejected: ['Zamioculcas zamiifolia Raven'],
      },
    },
  };
  const zzLabel = async (text: string) =>
    (await answer().grade(await trialOf({ text }, zz), NO_JUDGE)).score?.label;
  assertEquals(await zzLabel('Zamioculcas zamiifolia Raven'), 'wrong');
  assertEquals(await zzLabel('A ZZ plant, not Zamioculcas zamiifolia Raven'), 'partial');
  assertEquals(await zzLabel('Zamioculcas zamiifolia'), 'accepted');
});

Deno.test('a rejected JSON answer says the case rejects it', async () => {
  const confused: EvalCase = {
    ...POTHOS,
    expect: { answer: { accepted: ['Epipremnum aureum'], rejected: ['Epipremnum pinnatum'] } },
  };
  const result = await answer({ from: { json: 'species' } }).grade(
    await trialOf({ structured: { species: 'epipremnum pinnatum' } }, confused),
    NO_JUDGE,
  );
  assertEquals(
    [result.score?.label, result.passed, result.explanation],
    [
      'wrong',
      false,
      'answered "epipremnum pinnatum" (JSON key species), which the case rejects; accepted Epipremnum aureum',
    ],
  );
});

Deno.test('answer reads a JSON key when the suite names one, compared whole', async () => {
  const fromJson = answer({ from: { json: 'plant.species' } });
  assertEquals(
    await labelOf(fromJson, { structured: { plant: { species: 'epipremnum AUREUM' } } }),
    ['accepted', true, 'answered "epipremnum AUREUM" (JSON key plant.species)'],
  );
  assertEquals(
    (await labelOf(fromJson, { structured: { plant: { species: 'Epipremnum' } } }))[0],
    'partial',
  );
  // Compared whole: a longer answer that mentions an accepted name is not that name.
  assertEquals(
    (await labelOf(fromJson, { structured: { plant: { species: 'not Epipremnum aureum' } } }))[0],
    'wrong',
  );
  assertEquals(await labelOf(fromJson, { structured: { plant: {} } }), [
    'wrong',
    false,
    "no string at JSON key plant.species; accepted Epipremnum aureum, golden pothos, devil's ivy",
  ]);
  // The reply text is not read when a key is named.
  assertEquals((await labelOf(fromJson, { text: 'golden pothos' }))[0], 'wrong');
});

Deno.test('answer reads the last call of the committing tool', async () => {
  const fromTool = answer({ from: { tool: 'commit_id', arg: 'name' } });
  assertEquals(
    await labelOf(fromTool, {
      tools: ['lookup', 'commit_id', 'commit_id'],
      toolArguments: ['{"q":"pothos"}', '{"name":"Philodendron"}', '{"name":"Golden pothos"}'],
    }),
    ['accepted', true, 'answered "Golden pothos" (commit_id argument name)'],
  );
  assertEquals(await labelOf(fromTool, { tools: ['lookup'], text: 'golden pothos' }), [
    'wrong',
    false,
    "commit_id was not called; accepted Epipremnum aureum, golden pothos, devil's ivy",
  ]);
});

Deno.test('a turn the provider failed before it answered errors instead of counting wrong', async () => {
  const fromTool = answer({ from: { tool: 'commit_id', arg: 'name' } });
  assertEquals(await fromTool.grade(await trialOf({ stop: 'provider_error' }), NO_JUDGE), {
    name: 'answer',
    source: 'code',
    errorType: 'provider_error',
    explanation: 'commit_id was not called; the turn stopped provider_error before it answered',
  });
  const silent = await answer().grade(
    await trialOf({ stop: 'provider_error', text: 'let me look' }),
    NO_JUDGE,
  );
  assertEquals(
    [silent.errorType, silent.explanation],
    [
      'provider_error',
      'the reply names no answer; the turn stopped provider_error before it answered',
    ],
  );
  // An answer committed before the provider failed is graded, right or wrong.
  assertEquals(
    await labelOf(fromTool, {
      stop: 'provider_error',
      tools: ['commit_id'],
      toolArguments: ['{"name":"Philodendron"}'],
    }),
    [
      'wrong',
      false,
      'answered "Philodendron" (commit_id argument name); accepted Epipremnum aureum, golden pothos, devil\'s ivy',
    ],
  );
  assertEquals(
    (await labelOf(answer(), { stop: 'provider_error', text: 'golden pothos, I think' }))[0],
    'accepted',
  );
  // The provider's error kind, from the root's status, says which failure it was.
  const limited = await turnRecord({ stop: 'provider_error' });
  const root = limited.spans.find((span) => span.name.startsWith('invoke_agent'));
  if (root) root.status = { code: 'ERROR', message: 'rate_limit' };
  const trial = buildTrial({ suite: 's', case: POTHOS, index: 0, records: [limited] });
  assertEquals(
    (await fromTool.grade(trial, NO_JUDGE)).explanation,
    'commit_id was not called; the turn stopped provider_error (rate_limit) before it answered',
  );
  // Only a provider failure: a turn cut off at its length limit had its say.
  assertEquals((await labelOf(fromTool, { stop: 'length' }))[0], 'wrong');
});

Deno.test('answer without expect.answer is wrong, and says so', async () => {
  const bare: EvalCase = { id: 'x', kind: 'capability', input: { text: 'hi' } };
  const result = await answer().grade(await trialOf({ text: 'golden pothos' }, bare), NO_JUDGE);
  assertEquals(
    [result.score?.label, result.passed, result.explanation],
    ['wrong', false, 'case has no expect.answer'],
  );
});

function report(
  evalCase: EvalCase,
  index: number,
  label: 'accepted' | 'partial' | 'wrong' | undefined,
  turn?: TrialReport['turn'],
): TrialReport {
  const results: EvalResult[] =
    label === undefined
      ? [{ name: 'answer', source: 'code', errorType: 'provider' }]
      : [
          {
            name: 'answer',
            source: 'code',
            score: { value: label === 'accepted' ? 1 : 0, label },
            passed: label === 'accepted',
          },
        ];
  return {
    case: evalCase,
    index,
    outcome: label === undefined ? 'errored' : label === 'accepted' ? 'passed' : 'failed',
    results,
    ...(turn ? { turn } : {}),
    records: [],
    unpriced: 0,
    priced: 0,
    judgeRecords: [],
  };
}

Deno.test('the run is reported overall and by tag: accuracy, pass^k, time and loops', () => {
  const cactus: EvalCase = { ...POTHOS, id: 'cactus-01', tags: ['succulent', 'photo'] };
  const untagged: EvalCase = { ...POTHOS, id: 'bare-01', tags: undefined };
  const turn = (durationMs: number, modelCalls: number, toolCalls: number, stop = 'completed') => ({
    durationMs,
    modelCalls,
    toolCalls,
    stop,
  });
  const trials = [
    report(POTHOS, 0, 'accepted', turn(1000, 2, 1)),
    report(POTHOS, 1, 'accepted', turn(1200, 2, 1)),
    report(POTHOS, 2, 'accepted', turn(900, 1, 0)),
    report(cactus, 0, 'accepted', turn(4000, 5, 4)),
    report(cactus, 1, 'partial', turn(6000, 6, 5, 'length')),
    report(cactus, 2, undefined),
    report(untagged, 0, 'wrong', turn(2000, 3, 2)),
  ];
  const verdicts = [POTHOS, cactus, untagged].map((evalCase) =>
    caseVerdict(
      evalCase,
      trials.filter((each) => each.case?.id === evalCase.id).map((each) => each.results),
    ),
  );
  assertEquals(groupSummaries({ trials, verdicts }), [
    {
      group: 'all',
      cases: 3,
      casesPassed: 1,
      casesUndecided: 0,
      trials: 7,
      trialsPassed: 4,
      trialsErrored: 1,
      answers: { accepted: 4, partial: 1, wrong: 1, none: 1 },
      // The errored trial left no trace, so it has no stop.
      stops: { completed: 5, length: 1 },
      // Nearest rank over the six turns that left a trace: each value is one a trial had.
      durationMs: { median: 1200, p90: 6000 },
      modelCalls: { median: 2, p90: 6 },
      toolCalls: { median: 1, p90: 5 },
    },
    {
      group: 'houseplant',
      cases: 1,
      casesPassed: 1,
      casesUndecided: 0,
      trials: 3,
      trialsPassed: 3,
      trialsErrored: 0,
      answers: { accepted: 3, partial: 0, wrong: 0, none: 0 },
      stops: { completed: 3 },
      durationMs: { median: 1000, p90: 1200 },
      modelCalls: { median: 2, p90: 2 },
      toolCalls: { median: 1, p90: 1 },
    },
    {
      group: 'photo',
      cases: 2,
      casesPassed: 1,
      casesUndecided: 0,
      trials: 6,
      trialsPassed: 4,
      trialsErrored: 1,
      answers: { accepted: 4, partial: 1, wrong: 0, none: 1 },
      stops: { completed: 4, length: 1 },
      durationMs: { median: 1200, p90: 6000 },
      modelCalls: { median: 2, p90: 6 },
      toolCalls: { median: 1, p90: 5 },
    },
    {
      group: 'succulent',
      cases: 1,
      casesPassed: 0,
      casesUndecided: 0,
      trials: 3,
      trialsPassed: 1,
      trialsErrored: 1,
      answers: { accepted: 1, partial: 1, wrong: 0, none: 1 },
      stops: { completed: 1, length: 1 },
      durationMs: { median: 4000, p90: 6000 },
      modelCalls: { median: 5, p90: 6 },
      toolCalls: { median: 4, p90: 5 },
    },
  ]);
});

Deno.test('a suite without an answer grader reports no answer counts', () => {
  const trial: TrialReport = {
    case: POTHOS,
    index: 0,
    outcome: 'passed',
    results: [{ name: 'stop_kind', source: 'code', passed: true }],
    records: [],
    unpriced: 0,
    priced: 0,
    judgeRecords: [],
  };
  const [all] = groupSummaries({
    trials: [trial],
    verdicts: [caseVerdict(POTHOS, [trial.results])],
  });
  assertEquals(all?.answers, undefined);
  assertEquals(all?.stops, {});
  assertEquals(all?.durationMs, undefined);
});

/** Answers every turn with `name` as its structured `label`, keeping the media each turn carried. */
function namer(name: string): ModelProvider & { seen: InteractionPart[][] } {
  const seen: InteractionPart[][] = [];
  return {
    seen,
    async *complete(req) {
      const user = req.history?.findLast((message) => message.role === 'user');
      const parts = [...(user ? historyMessageParts(user) : []), ...req.input];
      seen.push(parts.filter((part) => part.type !== 'text'));
      await Promise.resolve();
      yield { type: 'tokens', tokens: { input: 10, output: 5, total: 15 } };
      yield { type: 'structured', structured: { label: name, explanation: 'leaf shape' } };
    },
  };
}

Deno.test('a photo beside the cases is pinned at load and its bytes reach the turn', async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/photos`);
  const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  await Deno.writeFile(`${dir}/photos/leaf.jpg`, photo);
  const sha256 = createHash('sha256').update(photo).digest('hex');
  const leaf = (pin: string) =>
    JSON.stringify({
      id: 'leaf-01',
      kind: 'capability',
      input: {
        text: 'what plant is this?',
        attachments: [{ mimeType: 'image/jpeg', path: 'photos/leaf.jpg', sha256: pin }],
      },
      expect: { answer: { accepted: ['Epipremnum aureum', 'golden pothos'] } },
      tags: ['houseplant'],
    });
  await Deno.writeTextFile(`${dir}/cases.jsonl`, `${leaf(sha256)}\n`);
  await Deno.writeTextFile(
    `${dir}/suite.ts`,
    `import '${Deno.cwd()}/tests/evals/judge/profile.ts';
     import { answer } from '${Deno.cwd()}/src/evals/graders/answer.ts';
     export default { id: 'plants', profile: 'eval.judge.seeing', mode: 'turn', cases: './cases.jsonl', trials: { repeat: 2 }, graders: [answer({ from: { json: 'label' } })] };`,
  );
  const loaded = await loadSuite(`${dir}/suite.ts`);
  const [loadedCase] = loaded.cases;
  const input = loadedCase?.input;
  // The loaded case holds the path absolute, so the runner does not depend on where it was started.
  assertEquals(input && 'attachments' in input ? input.attachments : undefined, [
    { mimeType: 'image/jpeg', path: `${dir}/photos/leaf.jpg`, sha256 },
  ]);

  const provider = namer('Golden pothos');
  const run = await runSuite(loaded, { provider });
  const image = {
    type: 'image',
    mimeType: 'image/jpeg',
    data: btoa(String.fromCharCode(...photo)),
  };
  assertEquals(provider.seen, [[image], [image]]);
  assertEquals(run.passed, true);
  assertEquals(
    run.trials.map((report) => [
      report.results[0]?.score?.label,
      report.turn?.modelCalls,
      report.turn?.stop,
    ]),
    [
      ['accepted', 1, 'completed'],
      ['accepted', 1, 'completed'],
    ],
  );

  // A photo changed after the case pinned it is refused at the trial that reads it.
  await Deno.writeFile(`${dir}/photos/leaf.jpg`, new Uint8Array([0, 1, 2]));
  const changed = await runSuite(loaded, { provider: namer('Golden pothos'), repeat: 1 });
  assertEquals(
    changed.trials.map((report) => [report.outcome, report.error]),
    [['errored', 'config']],
  );
  // And at load, before anything is spent, naming the case.
  await assertRejects(() => loadSuite(`${dir}/suite.ts`), TheoremError, 'case leaf-01: attachment');
  await Deno.remove(`${dir}/photos/leaf.jpg`);
  await assertRejects(() => loadSuite(`${dir}/suite.ts`), TheoremError, 'cannot be read');
  await Deno.writeTextFile(`${dir}/cases.jsonl`, `${leaf('ABC')}\n`);
  await assertRejects(
    () => loadSuite(`${dir}/suite.ts`),
    TheoremError,
    'must be a lowercase hex SHA-256',
  );
});
