/**
 * labels-exempt-file: benchmark runner — not runtime user or model copy (P2)
 *
 * Sends every text of each dataset across its guardrail boundary, on the studio's probe, and
 * scores what Theorem's detectors did with it. Writes `.guardrails-bench/<run>/results.jsonl`, one
 * line per text, and `summary.json`, and prints the summary.
 *
 *   deno task bench:guardrails [--dataset=a,b] [--role=train,test] [--limit=N] [--workers=N]
 *                              [--holdout] [--root=DIR] [--corpus=DIR]
 *
 * The data root is `--root`, or `GUARDRAIL_DATA`, or `~/Development/.guardrail-data`. The guardrail
 * corpus is `--corpus`, or `GUARDRAIL_CORPUS`, or `guardrail-corpus` under the root.
 */
import {
  BENCH_DIR,
  BENCH_PROGRESS_MS,
  type BenchProgress,
  type BenchSummary,
  ROLES,
  type Role,
} from '../studio/guardrail-bench.ts';
import {
  type BenchDataset,
  type BenchSample,
  CORPUS,
  DATASETS,
  type Locate,
} from './guardrails-bench/datasets.ts';
import { detectorsAt } from './guardrails-bench/probe.ts';
import {
  type BenchRow,
  type DatasetScore,
  formatScores,
  scoreDataset,
} from './guardrails-bench/score.ts';
import type { BatchReply, BatchRequest } from './guardrails-bench/worker.ts';

const DEFAULT_ROOT = `${Deno.env.get('HOME')}/Development/.guardrail-data`;
const OUT = BENCH_DIR;
const BATCH = 50;

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return Deno.args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const root = option('root') ?? Deno.env.get('GUARDRAIL_DATA') ?? DEFAULT_ROOT;
const corpus =
  option('corpus') ?? Deno.env.get('GUARDRAIL_CORPUS') ?? `${root}/${CORPUS.slice(0, -1)}`;
const locate: Locate = (file) =>
  file.startsWith(CORPUS) ? `${corpus}/${file.slice(CORPUS.length)}` : `${root}/${file}`;
const limit = option('limit') === undefined ? undefined : Number(option('limit'));
const workers = Number(option('workers') ?? Math.max(1, navigator.hardwareConcurrency - 1));
const holdout = Deno.args.includes('--holdout');
const only = option('dataset')?.split(',');
const roles = (option('role')?.split(',') ??
  ROLES.filter((role) => role !== 'holdout' || holdout)) as Role[];

for (const id of only ?? []) {
  if (!DATASETS.some((dataset) => dataset.id === id)) throw new Error(`No dataset ${id}.`);
}
if (roles.includes('holdout') && !holdout) throw new Error('A hold-out runs only with --holdout.');

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

class Pool {
  readonly #idle: Worker[];
  readonly #waiting: ((worker: Worker) => void)[] = [];
  readonly #all: Worker[];

  constructor(size: number) {
    const url = new URL('./guardrails-bench/worker.ts', import.meta.url).href;
    this.#all = Array.from({ length: size }, () => new Worker(url, { type: 'module' }));
    this.#idle = [...this.#all];
  }

  async run(request: BatchRequest): Promise<BatchReply> {
    const worker =
      this.#idle.pop() ?? (await new Promise<Worker>((resolve) => this.#waiting.push(resolve)));
    try {
      return await new Promise<BatchReply>((resolve, reject) => {
        worker.onmessage = (message: MessageEvent<BatchReply>) => resolve(message.data);
        worker.onerror = (event) => {
          event.preventDefault();
          reject(new Error(event.message));
        };
        worker.postMessage(request);
      });
    } finally {
      const next = this.#waiting.shift();
      if (next) next(worker);
      else this.#idle.push(worker);
    }
  }

  close(): void {
    for (const worker of this.#all) worker.terminate();
  }
}

async function* batches(dataset: BenchDataset): AsyncIterable<BenchSample[]> {
  let batch: BenchSample[] = [];
  let read = 0;
  for await (const sample of dataset.read(locate)) {
    if (limit !== undefined && read >= limit) break;
    read++;
    batch.push(sample);
    if (batch.length === BATCH) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

async function benchDataset(
  dataset: BenchDataset,
  pool: Pool,
  write: (row: BenchRow) => Promise<void>,
  progressed: (rows: BenchRow[]) => void,
): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  const inflight = new Set<Promise<void>>();
  let n = 0;
  for await (const samples of batches(dataset)) {
    const batch = n++;
    const task = pool
      .run({ batch, boundary: dataset.boundary, texts: samples.map((sample) => sample.text) })
      .then(async (reply) => {
        if ('error' in reply) throw new Error(`${dataset.id} batch ${batch}: ${reply.error}`);
        for (const [i, outcome] of reply.outcomes.entries()) {
          const sample = samples[i];
          if (!sample) continue;
          const keep = outcome.detectors.length > 0 || sample.attack;
          const row: BenchRow = {
            dataset: dataset.id,
            role: dataset.role,
            boundary: dataset.boundary,
            id: sample.id,
            attack: sample.attack,
            category: sample.category,
            ...(sample.holds ? { holds: sample.holds } : {}),
            ...(sample.unscored ? { unscored: sample.unscored } : {}),
            ...outcome,
            ...(keep ? { text: sample.text } : {}),
          };
          rows.push(row);
          await write(row);
        }
        progressed(rows);
      });
    inflight.add(task);
    task.finally(() => inflight.delete(task));
    // why: Reading runs far ahead of probing; holding a few batches per worker keeps memory flat.
    if (inflight.size >= workers * 2) await Promise.race(inflight);
  }
  await Promise.all(inflight);
  return rows;
}

async function commit(): Promise<string> {
  const { stdout } = await new Deno.Command('git', {
    args: ['rev-parse', 'HEAD'],
    stdout: 'piped',
  }).output();
  return new TextDecoder().decode(stdout).trim();
}

const run = new Date()
  .toISOString()
  .replaceAll(':', '-')
  .replace(/\.\d+Z$/, 'Z');
const dir = `${OUT}/${run}`;
await Deno.mkdir(dir, { recursive: true });
const results = await Deno.open(`${dir}/results.jsonl`, { write: true, create: true });
const encoder = new TextEncoder();
const write = async (row: BenchRow) => {
  await results.write(encoder.encode(`${JSON.stringify(row)}\n`));
};

const chosen = DATASETS.filter(
  (dataset) => (only === undefined || only.includes(dataset.id)) && roles.includes(dataset.role),
);
const skipped: { dataset: string; reason: string }[] = [];
const scores: DatasetScore[] = [];
const pool = new Pool(workers);
const started = performance.now();
let told = 0;
/** Rewrites `progress.json` for the studio's Health view, at most once a {@linkcode BENCH_PROGRESS_MS}. */
const tell = (current?: { dataset: BenchDataset; rows: BenchRow[] }, now = false) => {
  if (!now && performance.now() - told < BENCH_PROGRESS_MS) return;
  told = performance.now();
  const progress: BenchProgress = {
    run,
    ...(limit === undefined ? {} : { limit }),
    seconds: (told - started) / 1000,
    datasets: chosen.map(({ id, role, boundary }) => ({ id, role, boundary })),
    skipped,
    scores: current
      ? [
          ...scores,
          scoreDataset(current.rows, current.dataset.labels, detectorsAt(current.dataset.boundary)),
        ]
      : scores,
    ...(current ? { current: { dataset: current.dataset.id, rows: current.rows.length } } : {}),
  };
  // why: A rename replaces the file whole, so the studio never reads one half written.
  Deno.writeTextFileSync(`${dir}/progress.json.part`, JSON.stringify(progress));
  Deno.renameSync(`${dir}/progress.json.part`, `${dir}/progress.json`);
};
tell(undefined, true);
try {
  for (const dataset of chosen) {
    const missing: string[] = [];
    for (const file of dataset.files) if (!(await exists(locate(file)))) missing.push(locate(file));
    if (missing.length > 0) {
      skipped.push({ dataset: dataset.id, reason: `missing: ${missing.join(', ')}` });
      continue;
    }
    const t0 = performance.now();
    const rows = await benchDataset(dataset, pool, write, (sofar) => {
      if (sofar.length > 0) tell({ dataset, rows: sofar });
    });
    console.error(
      `${dataset.id}: ${rows.length} rows in ${((performance.now() - t0) / 1000).toFixed(0)}s`,
    );
    if (rows.length === 0) {
      skipped.push({ dataset: dataset.id, reason: 'no rows read' });
      continue;
    }
    scores.push(scoreDataset(rows, dataset.labels, detectorsAt(dataset.boundary)));
    tell(undefined, true);
  }
} finally {
  pool.close();
  results.close();
}

const summary: BenchSummary = {
  run,
  commit: await commit(),
  root,
  corpus,
  ...(limit === undefined ? {} : { limit }),
  seconds: (performance.now() - started) / 1000,
  profile: 'the example draft’s travel.concierge, every detector on flag',
  datasets: chosen.map(({ id, role, boundary, labels, license, attribution }) => ({
    id,
    role,
    boundary,
    labels,
    license,
    attribution,
  })),
  skipped,
  scores,
};
await Deno.writeTextFile(`${dir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
await Deno.writeTextFile(`${OUT}/latest`, `${run}\n`);
console.log(formatScores(scores));
for (const skip of skipped) console.log(`\nNot run: ${skip.dataset}: ${skip.reason}`);
console.log(`\n${dir}`);
