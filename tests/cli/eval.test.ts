import { assertEquals, assertMatch, assertStringIncludes } from '@std/assert';
import { evalCommand } from '../../src/cli/commands/eval.ts';
import { main } from '../../src/cli/index.ts';
import type { ModelProvider } from '../../src/kernel/types.ts';
import { turnRecord } from '../evals/fixture.ts';

const SUITE = 'tests/evals/translator/suite.ts';

/** Translates into whatever the case asks, with the first chunk tapped. */
const translator: ModelProvider = {
  async *complete(req) {
    req.tapUpstream?.({
      eventType: 'http_request',
      method: 'POST',
      url: 'https://x.test/',
      body: { stream: true },
    });
    await Promise.resolve();
    req.tapUpstream?.({ eventType: 'http_response', status: 200, headers: {} });
    req.tapUpstream?.({ eventType: 'sse', data: {} });
    const text = req.history?.findLast((message) => message.role === 'user')?.content ?? '';
    const lang = { Spanish: 'es', French: 'fr', German: 'de', Japanese: 'ja' };
    const hit = Object.entries(lang).find(([name]) => text.includes(name));
    yield { type: 'tokens', tokens: { input: 20, output: 10, total: 30, cost: { usd: 0.001 } } };
    yield { type: 'structured', structured: { lang: hit?.[1] ?? 'en', text: 'translated' } };
  },
};

async function captured(
  work: () => Promise<boolean>,
): Promise<{ ok: boolean; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => out.push(args.join(' '));
  console.error = (...args: unknown[]) => err.push(args.join(' '));
  try {
    return { ok: await work(), out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

Deno.test('eval runs a suite live with the host provider and prints one row per case', async () => {
  const { ok, out } = await captured(() =>
    evalCommand({ suite: SUITE, trials: 2, concurrency: 4 }, { provider: translator }),
  );
  assertEquals(ok, true);
  assertStringIncludes(out, 'Suite: translator.v1 (live, 2 trials per case)');
  for (const id of ['es-01', 'fr-01', 'de-01', 'ja-01']) assertStringIncludes(out, id);
  // Every cased trial as one group: the translator's cases carry no tags and grade no answers.
  assertStringIncludes(out, 'cases pass^k');
  assertStringIncludes(out, 'turn median / p90');
  assertMatch(
    out,
    /\n {2}all +4\/4 100% +8\/8 100% +- +\d+ms \/ \d+ms +1 \/ 1 +0 \/ 0 +completed 8/,
  );
  assertStringIncludes(out, '4/4 cases passed');
});

Deno.test('eval without a provider refuses to create one', async () => {
  const { ok, err } = await captured(() => evalCommand({ suite: SUITE }));
  assertEquals(ok, false);
  assertStringIncludes(err, 'does not create providers');
  assertStringIncludes(err, '--recorded');
});

Deno.test('eval grades recorded traces from a directory, names failures, and honours the threshold', async () => {
  const dir = await Deno.makeTempDir();
  const stamp = (id: string) => ({ eval: { suite: 'translator.v1', case: id, trial: 0 } });
  const good = await turnRecord({
    structured: { lang: 'es', text: 'hola' },
    timeToFirstChunk: 0.4,
    metadata: stamp('es-01'),
  });
  const wrong = await turnRecord({
    structured: { lang: 'en', text: 'where' },
    timeToFirstChunk: 0.4,
    metadata: stamp('fr-01'),
  });
  await Deno.writeTextFile(`${dir}/a.jsonl`, `${JSON.stringify(good)}\n${JSON.stringify(wrong)}\n`);

  const strict = await captured(() => evalCommand({ suite: SUITE, recorded: dir }));
  assertEquals(strict.ok, false);
  assertStringIncludes(strict.out, '(recorded, 3 trials per case)');
  assertStringIncludes(strict.out, 'fr-01 trial 0:');
  assertStringIncludes(strict.out, 'delivered_json: fields differ');
  assertStringIncludes(strict.out, '1/4 cases passed');

  // A quarter of the cases passing is enough at this threshold.
  const lenient = await captured(() =>
    evalCommand({ suite: SUITE, recorded: dir, threshold: 0.25 }),
  );
  assertEquals(lenient.ok, true);

  const json = await captured(() =>
    evalCommand({ suite: SUITE, recorded: `${dir}/a.jsonl`, json: true }),
  );
  const parsed = JSON.parse(json.out);
  assertEquals(parsed.suite, 'translator.v1');
  assertEquals(parsed.mode, 'recorded');
  assertEquals(parsed.passed, false);
  assertEquals(parsed.verdicts.length, 4);
  assertEquals(parsed.trials.length, 2);
  assertEquals(typeof parsed.runTraceId, 'string');
});

Deno.test('eval writes trial and run records under --trace-dir', async () => {
  const dir = await Deno.makeTempDir();
  const { ok } = await captured(() =>
    evalCommand({ suite: SUITE, trials: 1, traceDir: dir }, { provider: translator }),
  );
  assertEquals(ok, true);
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) files.push(entry.name);
  assertEquals(files.length > 0, true);
  const text = await Deno.readTextFile(`${dir}/${files.sort()[0]}`);
  assertStringIncludes(text, 'theorem.eval.trial');
  assertStringIncludes(text, 'theorem.eval.run');
  // The judged turns themselves are there too, so a human can read what a label points at.
  assertStringIncludes(text, '"gen_ai.input.messages"');
});

Deno.test('eval rejects flags that make no sense before loading anything', async () => {
  const badThreshold = await captured(() => evalCommand({ suite: SUITE, threshold: 2 }));
  assertEquals(badThreshold.ok, false);
  assertStringIncludes(badThreshold.err, '--threshold');
  const badTrials = await captured(() => evalCommand({ suite: SUITE, trials: 0 }));
  assertEquals(badTrials.ok, false);
  assertStringIncludes(badTrials.err, '--trials');
  const badConcurrency = await captured(() => evalCommand({ suite: SUITE, concurrency: 1.5 }));
  assertEquals(badConcurrency.ok, false);
  assertStringIncludes(badConcurrency.err, '--concurrency');
  const missing = await captured(() => evalCommand({ suite: 'tests/evals/translator/nope.ts' }));
  assertEquals(missing.ok, false);
});

Deno.test('the CLI router runs eval over recorded traces and the help names it', async () => {
  const dir = await Deno.makeTempDir();
  const good = await turnRecord({
    structured: { lang: 'es', text: 'hola' },
    timeToFirstChunk: 0.4,
    metadata: { eval: { suite: 'translator.v1', case: 'es-01', trial: 0 } },
  });
  await Deno.writeTextFile(`${dir}/t.jsonl`, `${JSON.stringify(good)}\n`);
  const run = await captured(async () => {
    await main(['eval', SUITE, '--recorded', `${dir}/t.jsonl`, '--threshold', '0.25', '--json']);
    return true;
  });
  assertEquals(JSON.parse(run.out).verdicts[0].passed, true);
  const help = await captured(async () => {
    await main(['help']);
    return true;
  });
  assertStringIncludes(help.out, 'eval <suite>');
  assertStringIncludes(help.out, '--recorded <path>');
});

Deno.test('eval says a cost went unreported rather than printing zero', async () => {
  const unpriced: ModelProvider = {
    async *complete(req) {
      for await (const event of translator.complete(req)) {
        yield event.type === 'tokens'
          ? { type: 'tokens', tokens: { input: 20, output: 10, total: 30 } }
          : event;
      }
    },
  };
  const { out } = await captured(() =>
    evalCommand({ suite: SUITE, trials: 2 }, { provider: unpriced }),
  );
  assertStringIncludes(out, '4/4 cases passed; cost not reported (8 calls)');
  const priced = await captured(() =>
    evalCommand({ suite: SUITE, trials: 2 }, { provider: translator }),
  );
  assertStringIncludes(priced.out, '4/4 cases passed; cost $0.0080');
  // A reported $0 is a cost: free calls beside unreported ones are not "not reported".
  let calls = 0;
  const mixed: ModelProvider = {
    async *complete(req) {
      const reports = calls++ % 2 === 0;
      for await (const event of translator.complete(req)) {
        yield event.type === 'tokens'
          ? {
              type: 'tokens',
              tokens: {
                input: 20,
                output: 10,
                total: 30,
                ...(reports ? { cost: { usd: 0 } } : {}),
              },
            }
          : event;
      }
    },
  };
  const free = await captured(() => evalCommand({ suite: SUITE, trials: 2 }, { provider: mixed }));
  assertStringIncludes(
    free.out,
    '4/4 cases passed; cost $0.0000, plus 4 calls whose cost went unreported',
  );
});

/** Says every record is correct, for a cost of its own. */
const affirmingJudge: ModelProvider = {
  async *complete() {
    await Promise.resolve();
    yield { type: 'tokens', tokens: { input: 200, output: 20, total: 220, cost: { usd: 0.002 } } };
    yield {
      type: 'structured',
      structured: { label: 'correct', explanation: 'the translation is right' },
    };
  },
};

Deno.test('eval hands a judged suite the judge provider the host passes, and its cost counts', async () => {
  const judged = 'tests/evals/judge/suite.ts';
  const { ok, out } = await captured(() =>
    evalCommand(
      { suite: judged, trials: 1, json: true },
      { provider: translator, judgeProvider: affirmingJudge },
    ),
  );
  assertEquals(ok, true);
  const parsed = JSON.parse(out);
  assertEquals(parsed.suite, 'translator.judged.v1');
  assertEquals(parsed.verdicts.length, 4);
  // Four agent turns at 0.001 and four judge turns at 0.002.
  assertEquals(Math.round(parsed.costUsd * 1000) / 1000, 0.012);
  const results = parsed.trials[0].results as { name: string; source: string; passed?: boolean }[];
  const verdict = results.find((result) => result.name === 'correctness');
  assertEquals(verdict?.source, 'model');
  assertEquals(verdict?.passed, true);

  // Without a judge provider the agent's provider judges; a dead one is an error, not a crash.
  const dead: ModelProvider = {
    complete: () => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('judge is down')) }),
    }),
  };
  const down = await captured(() =>
    evalCommand({ suite: judged, trials: 1 }, { provider: translator, judgeProvider: dead }),
  );
  assertEquals(down.ok, false);
  assertStringIncludes(down.out, 'correctness:');
  // A judge that failed every trial decided nothing: no case failed, none passed.
  assertStringIncludes(down.out, '0/0 cases passed (+4 undecided)');
});
