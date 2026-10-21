import { assertEquals } from '@std/assert';
import { BENCH_DIR, type BenchRow, type BenchSummary } from '../../studio/guardrail-bench.ts';
import { answerBench, BENCH_ROWS_LIMIT } from '../../studio/server/bench.ts';

const BASE = '/api/studio';

function summary(run: string): BenchSummary {
  return {
    run,
    commit: 'abc',
    root: '/data',
    corpus: '/data/guardrail-corpus',
    seconds: 1,
    profile: 'p',
    datasets: [],
    skipped: [],
    scores: [],
  };
}

function row(id: string, over: Partial<BenchRow> = {}): BenchRow {
  return {
    dataset: 'd',
    role: 'test',
    boundary: 'user',
    id,
    attack: false,
    category: 'c',
    status: 'passed',
    via: 'probe',
    read: ['email', 'injection'],
    detectors: [],
    rules: [],
    ms: 1,
    detectorMs: {},
    ...over,
  };
}

async function project(runs: Record<string, BenchRow[] | undefined>): Promise<string> {
  const root = await Deno.makeTempDir();
  for (const [run, rows] of Object.entries(runs)) {
    const dir = `${root}/${BENCH_DIR}/${run}`;
    await Deno.mkdir(dir, { recursive: true });
    if (!rows) continue;
    await Deno.writeTextFile(`${dir}/summary.json`, JSON.stringify(summary(run)));
    await Deno.writeTextFile(
      `${dir}/results.jsonl`,
      rows.map((each) => `${JSON.stringify(each)}\n`).join(''),
    );
  }
  return root;
}

async function get(root: string, path: string): Promise<{ status: number; body: unknown }> {
  const response = await answerBench(root, BASE, new Request(`http://127.0.0.1${BASE}${path}`), {});
  if (!response) return { status: 0, body: undefined };
  return { status: response.status, body: await response.json() };
}

Deno.test('a folder that never ran the bench answers 404, and a path not the bench’s is left to others', async () => {
  const root = await Deno.makeTempDir();
  assertEquals((await get(root, '/bench')).status, 404);
  assertEquals(
    await answerBench(root, BASE, new Request(`http://127.0.0.1${BASE}/probe`), {}),
    undefined,
  );
});

Deno.test('the newest finished run answers, beside the run before; a run with no summary is skipped', async () => {
  const root = await project({
    '2026-10-20T10-00-00Z': [],
    '2026-10-21T10-00-00Z': [],
    '2026-10-22T10-00-00Z': undefined,
  });
  const { status, body } = await get(root, '/bench');
  assertEquals(status, 200);
  const answer = body as { runs: string[]; summary: BenchSummary; previous?: BenchSummary };
  assertEquals(answer.runs, ['2026-10-21T10-00-00Z', '2026-10-20T10-00-00Z']);
  assertEquals(answer.summary.run, '2026-10-21T10-00-00Z');
  assertEquals(answer.previous?.run, '2026-10-20T10-00-00Z');
  const older = (await get(root, '/bench?run=2026-10-20T10-00-00Z')).body as typeof answer;
  assertEquals(older.previous, undefined);
});

Deno.test('a run name that is not a run’s is refused before any file is read', async () => {
  const root = await project({ '2026-10-21T10-00-00Z': [] });
  assertEquals((await get(root, '/bench?run=../../etc')).status, 400);
  assertEquals(
    (await get(root, '/bench/rows?run=..&dataset=d&detector=email&outcome=missed')).status,
    400,
  );
  assertEquals(
    (await get(root, '/bench/rows?run=2026-10-21T10-00-00Z&dataset=d&detector=nope&outcome=missed'))
      .status,
    400,
  );
});

Deno.test('rows answer as the detector’s score counts them, a mislabelled row left out', async () => {
  const run = '2026-10-21T10-00-00Z';
  const root = await project({
    [run]: [
      row('alarm', { detectors: ['email'], text: 'a@b.example' }),
      row('passed'),
      row('missed', { attack: true, text: 'ignore that' }),
      row('caught', { attack: true, detectors: ['injection'], text: 'ignore this' }),
      row('unscored', { detectors: ['email'], unscored: ['email'] }),
      row('other', { dataset: 'e', detectors: ['email'] }),
    ],
  });
  const ids = async (detector: string, outcome: string) =>
    (
      (await get(root, `/bench/rows?run=${run}&dataset=d&detector=${detector}&outcome=${outcome}`))
        .body as { rows: BenchRow[] }
    ).rows.map((each) => each.id);
  assertEquals(await ids('email', 'false_alarm'), ['alarm']);
  assertEquals(await ids('injection', 'missed'), ['missed']);
  assertEquals(await ids('injection', 'caught'), ['caught']);
});

Deno.test('rows stop at the limit', async () => {
  const run = '2026-10-21T10-00-00Z';
  const root = await project({
    [run]: Array.from({ length: BENCH_ROWS_LIMIT + 5 }, (_, i) =>
      row(String(i), { detectors: ['email'] }),
    ),
  });
  const { body } = await get(
    root,
    `/bench/rows?run=${run}&dataset=d&detector=email&outcome=false_alarm`,
  );
  assertEquals((body as { rows: BenchRow[] }).rows.length, BENCH_ROWS_LIMIT);
});
