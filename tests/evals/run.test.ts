/**
 * Running a suite: live mode runs the profile and grades what the sink caught;
 * recorded mode grades the same records to the same results. Errors, budget
 * stops, caseless traces and suite loading are each pinned here.
 */

import { stopKind } from '../../src/evals/graders/code.ts';
import { runSuite, type SuiteRun, type TrialReport } from '../../src/evals/run.ts';
import { type LoadedSuite, loadSuite, readTraceRecords } from '../../src/evals/suite.ts';
import type { EvalCase, EvalSuite } from '../../src/evals/types.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from '../../src/kernel/engine/assert.ts';
import type { TurnEvent } from '../../src/kernel/turn-events.ts';
import type { ModelProvider } from '../../src/kernel/types.ts';
import { memorySink } from '../../src/observability/trace.ts';
import type { TraceRecord } from '../../src/observability/trace-record.ts';
import { catalogedSink, catalogGate } from '../fixtures/trace-catalog.ts';
import { turnRecord } from './fixture.ts';
import { TRANSLATOR } from './translator/profile.ts';

const SUITE_PATH = 'tests/evals/translator/suite.ts';

const TRANSLATIONS: Record<string, { lang: string; text: string }> = {
  'es-01': { lang: 'es', text: 'La tetera está encendida.' },
  'fr-01': { lang: 'fr', text: 'Où est la gare ?' },
  'de-01': { lang: 'de', text: 'Ich wäre gekommen, wenn ich es gewusst hätte.' },
  'ja-01': { lang: 'ja', text: 'お待たせいたしました。お席のご用意ができました。' },
};

/**
 * Answers every case from the table above, reporting a cost per call; `wrong`
 * cases answer in English. Taps one streamed HTTP try the way an adapter does,
 * so the trace records the reply's first chunk.
 */
function translator(options: { wrong?: string[]; costUsd?: number } = {}): ModelProvider {
  return {
    async *complete(req) {
      req.tapUpstream?.({
        eventType: 'http_request',
        method: 'POST',
        url: 'https://example.test/v1/interactions',
        body: { stream: true },
      });
      await Promise.resolve();
      req.tapUpstream?.({ eventType: 'http_response', status: 200, headers: {} });
      // The first streamed row is the reply's first chunk.
      req.tapUpstream?.({ eventType: 'sse', data: { chunk: 1 } });
      // The person's text arrives as the last user history message (wrapped as user data).
      const text = req.history?.findLast((message) => message.role === 'user')?.content ?? '';
      const id = Object.keys(TRANSLATIONS).find((key) => {
        const [lang] = key.split('-');
        return text.includes(
          { es: 'Spanish', fr: 'French', de: 'German', ja: 'Japanese' }[lang] ?? '',
        );
      });
      const answer = id ? TRANSLATIONS[id] : { lang: 'en', text };
      const events: TurnEvent[] = [
        {
          type: 'tokens',
          tokens: {
            input: 20,
            output: 10,
            total: 30,
            ...(options.costUsd === undefined ? {} : { cost: { usd: options.costUsd } }),
          },
        },
        {
          type: 'structured',
          structured:
            id && options.wrong?.includes(id) ? { lang: 'en', text: answer.text } : answer,
        },
      ];
      for (const event of events) yield event;
    },
  };
}

function resultsOf(run: SuiteRun): string[] {
  return run.trials.map((report) =>
    JSON.stringify([report.case?.id, report.index, report.results]),
  );
}

function turnRecords(run: SuiteRun): TraceRecord[] {
  return run.trials.flatMap((report) => report.records);
}

Deno.test('live mode runs every case repeat times and passes the translator', async () => {
  const loaded = await loadSuite(SUITE_PATH);
  const written: TraceRecord[] = [];
  const run = await runSuite(loaded, {
    provider: translator({ costUsd: 0.001 }),
    repeat: 2,
    sink: catalogedSink(written),
  });
  assertEquals(run.mode, 'live');
  assertEquals(run.repeat, 2);
  assertEquals(run.passed, true);
  assertEquals(run.verdicts.length, 4);
  assertEquals(
    run.verdicts.map((verdict) => [verdict.case, verdict.passed, verdict.trialsPassed]),
    [
      ['es-01', true, 2],
      ['fr-01', true, 2],
      ['de-01', true, 2],
      ['ja-01', true, 2],
    ],
  );
  assertEquals(run.trials.length, 8);
  assertEquals(run.costUsd, 0.008);
  // Every turn is stamped so recorded mode can find its case again.
  for (const report of run.trials) {
    assertEquals(report.records[0]?.metadata?.eval, {
      suite: 'translator.v1',
      case: report.case?.id,
      trial: report.index,
    });
  }
  // Eight turns, their eight trial records and one run record reached the sink, all cataloged.
  assertEquals(written.length, 17);
  assertEquals(
    written.filter((record) => record.spans[0]?.name === 'theorem.eval.trial').length,
    8,
  );
  assertEquals(written.at(-1)?.spans[0]?.name, 'theorem.eval.run');
  assertEquals(run.warnings, []);
});

Deno.test('recorded mode over the live run records gives byte-identical results', async () => {
  const loaded = await loadSuite(SUITE_PATH);
  const live = await runSuite(loaded, {
    provider: translator({ wrong: ['de-01'] }),
    repeat: 2,
  });
  assertEquals(live.passed, false);
  assertEquals(live.verdicts.find((verdict) => verdict.case === 'de-01')?.passed, false);
  const recorded = await runSuite(loaded, { recorded: turnRecords(live) });
  assertEquals(recorded.mode, 'recorded');
  assertEquals(recorded.passed, false);
  assertEquals(resultsOf(recorded).sort(), resultsOf(live).sort());
  assertEquals(recorded.verdicts, live.verdicts);
  assertEquals(recorded.caseless, []);
});

Deno.test('a wrong answer names the grader and the field', async () => {
  const loaded = await loadSuite(SUITE_PATH);
  const run = await runSuite(loaded, { provider: translator({ wrong: ['fr-01'] }), repeat: 1 });
  const report = run.trials.find((entry) => entry.case?.id === 'fr-01');
  assertEquals(report?.outcome, 'failed');
  const json = report?.results.find((result) => result.name === 'delivered_json');
  assertEquals(json?.passed, false);
  assertStringIncludes(json?.explanation ?? '', 'lang');
  assertEquals(run.warnings, [
    'one trial per case cannot tell noise from change; set trials.repeat to 3 or more',
  ]);
});

Deno.test('a turn that fails still leaves a trace, and the trace is what gets graded', async () => {
  const loaded = await loadSuite(SUITE_PATH);
  // The stream rejects on its first read, as a dead upstream does.
  const provider: ModelProvider = {
    complete: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new TheoremError('unavailable', 'upstream down')),
      }),
    }),
  };
  const run = await runSuite(loaded, { provider, repeat: 1 });
  assertEquals(run.passed, false);
  for (const report of run.trials) {
    assertEquals(report.records.length > 0, true);
    assertEquals(report.outcome, 'failed');
    assertEquals(report.results.find((result) => result.name === 'stop_kind')?.passed, false);
  }
});

Deno.test('an error before the trace marks every applicable result with its kind', async () => {
  const loaded = await loadSuite(SUITE_PATH);
  const caseless: LoadedSuite = {
    ...loaded,
    cases: [{ id: 'session', kind: 'regression', input: { session: { steps: [] } } }],
  };
  const run = await runSuite(caseless, { provider: translator(), repeat: 1 });
  const [report] = run.trials;
  assertEquals(report?.records, []);
  assertEquals(report?.error, 'config');
  assertEquals(report?.outcome, 'errored');
  assertEquals(report?.results.length, loaded.suite.graders.length);
  assertEquals(
    report?.results.every((result) => result.errorType === 'config'),
    true,
  );
  assertEquals(run.verdicts[0]?.trialsErrored, 1);
  assertEquals(run.passed, false);
});

Deno.test('the cost ceiling stops the run before the next trial, and the run says so', async () => {
  const loaded = await loadSuite(SUITE_PATH);
  const seen: TrialReport[] = [];
  const run = await runSuite(loaded, {
    provider: translator({ costUsd: 0.004 }),
    repeat: 3,
    maxCostUsd: 0.01,
    onTrial: (report) => seen.push(report),
  });
  // 0.004, 0.008, 0.012 > 0.01: three trials ran, the fourth never started.
  assertEquals(seen.length, 3);
  assertEquals(run.stopped, 'budget');
  assertEquals(run.passed, false);
  assertEquals(run.costUsd, 0.012);
  assertEquals(run.verdicts[0]?.trials, 3);
  assertEquals(run.verdicts[1]?.trials, 0);
  assertEquals(run.verdicts[1]?.passed, false);
  assertEquals(run.run.spans[0]?.attributes['theorem.eval.stopped'], 'budget');
});

Deno.test('concurrency runs trials side by side yet reports them in suite order', async () => {
  const loaded = await loadSuite(SUITE_PATH);
  let inFlight = 0;
  let peak = 0;
  const started: string[] = [];
  const inner = translator({ costUsd: 0.001 });
  const provider: ModelProvider = {
    async *complete(req) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      started.push(req.history?.findLast((message) => message.role === 'user')?.content ?? '');
      // Hold the call so the next worker overlaps it.
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        yield* inner.complete(req);
      } finally {
        inFlight -= 1;
      }
    },
  };
  const finished: string[] = [];
  const run = await runSuite(loaded, {
    provider,
    repeat: 2,
    concurrency: 3,
    onTrial: (report) => finished.push(`${report.case?.id}:${report.index}`),
  });
  assertEquals(peak, 3);
  assertEquals(run.passed, true);
  assertEquals(finished.length, 8);
  // Starts follow the suite: es, es, fr, fr, de, ...
  assertEquals(started[0]?.includes('Spanish'), true);
  assertEquals(started[2]?.includes('French'), true);
  assertEquals(
    run.trials.map((report) => `${report.case?.id}:${report.index}`),
    ['es-01:0', 'es-01:1', 'fr-01:0', 'fr-01:1', 'de-01:0', 'de-01:1', 'ja-01:0', 'ja-01:1'],
  );
  assertEquals(run.costUsd, 0.008);
  // The same verdicts whichever way the trials were run; only wall-clock latency wording differs.
  const sequential = await runSuite(loaded, {
    provider: translator({ costUsd: 0.001 }),
    repeat: 2,
  });
  const passes = (suiteRun: SuiteRun) =>
    suiteRun.trials.map((report) => [
      report.case?.id,
      report.index,
      report.results.map((result) => [result.name, result.passed]),
    ]);
  assertEquals(passes(run), passes(sequential));
  assertEquals(run.verdicts, sequential.verdicts);
});

Deno.test('with concurrency, a budget stop lets in-flight trials finish and count', async () => {
  const loaded = await loadSuite(SUITE_PATH);
  const run = await runSuite(loaded, {
    provider: translator({ costUsd: 0.004 }),
    repeat: 3,
    concurrency: 2,
    maxCostUsd: 0.01,
  });
  assertEquals(run.stopped, 'budget');
  // Two start together (0.008), two more start before the sum passes 0.01 (0.016); none after.
  assertEquals(run.trials.length, 4);
  assertEquals(run.costUsd, 0.016);
  assertEquals(run.passed, false);
});

Deno.test('recorded traces with no stamp for this suite are graded without a case', async () => {
  const loaded = await loadSuite(SUITE_PATH);
  const foreign = await turnRecord({
    structured: { lang: 'es', text: 'hola' },
    metadata: { eval: { suite: 'other.v1', case: 'es-01', trial: 0 } },
  });
  const production = await turnRecord({ structured: { lang: 'es', text: 'hola' } });
  const run = await runSuite(loaded, { recorded: [foreign, production] });
  assertEquals(run.trials, []);
  assertEquals(run.caseless.length, 2);
  assertEquals(
    run.caseless.map((report) => report.index),
    [0, 1],
  );
  // Graders that read the case's expect are skipped; the rest still grade.
  const names = run.caseless[0]?.results.map((result) => result.name) ?? [];
  assertEquals(names.includes('delivered_json'), false);
  assertEquals(names.includes('stop_kind'), true);
  assertEquals(run.run.spans[0]?.attributes['theorem.eval.caseless'], true);
  // Every case still gets a verdict, and with no trials none passes.
  assertEquals(
    run.verdicts.every((verdict) => !verdict.passed && verdict.trials === 0),
    true,
  );
});

Deno.test('a grader that throws is a grader_error result, not a crash', async () => {
  const loaded = await loadSuite(SUITE_PATH);
  const throwing: EvalSuite = {
    ...loaded.suite,
    graders: [
      {
        name: 'boom',
        identity: 'boom',
        source: 'code',
        needsExpect: false,
        grade: () => {
          throw new Error('kaboom');
        },
      },
      stopKind('completed'),
    ],
  };
  const run = await runSuite({ ...loaded, suite: throwing }, { provider: translator(), repeat: 1 });
  const [report] = run.trials;
  assertEquals(report?.outcome, 'errored');
  assertEquals(report?.results[0], {
    name: 'boom',
    source: 'code',
    errorType: 'grader_error',
    explanation: 'kaboom',
  });
  assertEquals(report?.results[1]?.passed, true);
});

Deno.test('runSuite refuses what it cannot run, as config errors', async () => {
  const loaded = await loadSuite(SUITE_PATH);
  const refuse = (patch: Partial<EvalSuite>, message: string) =>
    assertRejects(
      () =>
        runSuite({ ...loaded, suite: { ...loaded.suite, ...patch } }, { provider: translator() }),
      TheoremError,
      message,
    );
  await refuse({ mode: 'session' }, 'session suites are not run yet');
  await refuse({ graders: [] }, 'no graders');
  await assertRejects(() => runSuite(loaded, {}), TheoremError, 'live mode needs a provider');
});

Deno.test('loadSuite reads the module and its cases, and names a bad line', async () => {
  const loaded = await loadSuite(SUITE_PATH);
  assertEquals(loaded.suite.id, 'translator.v1');
  assertEquals(loaded.suite.profile, TRANSLATOR);
  assertEquals(
    loaded.cases.map((evalCase) => evalCase.id),
    ['es-01', 'fr-01', 'de-01', 'ja-01'],
  );
  assertEquals(loaded.provider, undefined);
  assertEquals(loaded.suite.graders.length, 5);

  const dir = await Deno.makeTempDir();
  const cases: EvalCase[] = [
    { id: 'a', kind: 'regression', input: { text: 'x' } },
    { id: 'a', kind: 'regression', input: { text: 'y' } },
  ];
  await Deno.writeTextFile(`${dir}/cases.jsonl`, cases.map((c) => JSON.stringify(c)).join('\n'));
  await Deno.writeTextFile(
    `${dir}/suite.ts`,
    `import { stopKind } from '${Deno.cwd()}/src/evals/graders/code.ts';
     import { registerProfile } from '${Deno.cwd()}/src/kernel/default-scope.ts';
     export default { id: 'dup', profile: 'translator', mode: 'turn', cases: './cases.jsonl', trials: { repeat: 3 }, graders: [stopKind('completed')] };
     export const provider = { complete: async function* () { await Promise.resolve(); } };
     void registerProfile;`,
  );
  await assertRejects(() => loadSuite(`${dir}/suite.ts`), TheoremError, 'case id a appears twice');

  await Deno.writeTextFile(
    `${dir}/cases.jsonl`,
    '{"id":"a","kind":"regression","input":{"text":"x"}}\nnot json\n',
  );
  await assertRejects(
    () => loadSuite(`${dir}/suite.ts`),
    TheoremError,
    'cases.jsonl:2: case is not JSON',
  );

  await Deno.writeTextFile(
    `${dir}/cases.jsonl`,
    '{"id":"a","kind":"sometimes","input":{"text":"x"}}\n',
  );
  await assertRejects(() => loadSuite(`${dir}/suite.ts`), TheoremError, 'cases.jsonl:1: case kind');

  await Deno.writeTextFile(
    `${dir}/cases.jsonl`,
    '{"id":"a","kind":"regression","input":{"text":"x"}}\n',
  );
  const withProvider = await loadSuite(`${dir}/suite.ts`);
  assertEquals(typeof withProvider.provider?.complete, 'function');

  await Deno.writeTextFile(`${dir}/empty.ts`, 'export const nothing = 1;');
  await assertRejects(
    () => loadSuite(`${dir}/empty.ts`),
    TheoremError,
    'default export is not an EvalSuite',
  );
});

Deno.test('readTraceRecords reads one file or every .jsonl file of a directory, in name order', async () => {
  const dir = await Deno.makeTempDir();
  const first = await turnRecord({ text: 'one' });
  const second = await turnRecord({ text: 'two' });
  await Deno.writeTextFile(`${dir}/b.jsonl`, `${JSON.stringify(second)}\n`);
  await Deno.writeTextFile(`${dir}/a.jsonl`, `${JSON.stringify(first)}\n\n`);
  await Deno.writeTextFile(`${dir}/notes.txt`, 'ignored');
  const fromDir = await readTraceRecords(dir);
  assertEquals(fromDir.length, 2);
  assertEquals(fromDir[0]?.spans[0]?.traceId, first.spans[0]?.traceId);
  const fromFile = await readTraceRecords(`${dir}/b.jsonl`);
  assertEquals(fromFile.length, 1);
  await Deno.writeTextFile(`${dir}/c.jsonl`, '{"v":2}\n');
  await assertRejects(() => readTraceRecords(dir), TheoremError, 'c.jsonl:1: trace record');
});

Deno.test('the sink sees trial records inside the judged trace and one run record', async () => {
  const loaded = await loadSuite(SUITE_PATH);
  const written: TraceRecord[] = [];
  const run = await runSuite(loaded, {
    provider: translator(),
    repeat: 1,
    sink: memorySink(written),
    revision: 'abc123',
  });
  const trialRecords = written.filter((record) => record.spans[0]?.name === 'theorem.eval.trial');
  assertEquals(trialRecords.length, 4);
  for (const [i, report] of run.trials.entries()) {
    assertEquals(trialRecords[i]?.spans[0]?.traceId, report.traceId);
    assertEquals(report.trialRecord, trialRecords[i]);
  }
  assertEquals(run.run.spans[0]?.attributes['vcs.ref.head.revision'], 'abc123');
  assertEquals(written.at(-1), run.run);
  // The graders the suite names all decided; nothing was informational only.
  assertEquals(
    run.trials[0]?.results.map((result) => result.name),
    ['delivered_json', 'tool_trajectory', 'stop_kind', 'budget', 'turn_latency'],
  );
});

catalogGate();
