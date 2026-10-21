/**
 * The guardrails bench's runs, for the Health view: `GET <base>/bench` answers a run's summary and
 * the run before it, and `GET <base>/bench/rows` the rows one detector counted one way. They read
 * the `.guardrails-bench` folder where the studio command ran, so only a checkout that ran the
 * bench answers; anywhere else both answer 404 and the view does not show.
 *
 * @module
 */
import { DETECTORS, type Detector } from '@theoremjs/agents/guardrails';
import {
  BENCH_DIR,
  BENCH_OUTCOMES,
  BENCH_RUN,
  type BenchOutcome,
  type BenchRow,
  type BenchRunAnswer,
  type BenchSummary,
  outcomeFor,
} from '../guardrail-bench.ts';
import { json } from './handler.ts';

/** The most rows one request answers: enough to read through, few enough to send at once. */
export const BENCH_ROWS_LIMIT = 100;

async function readSummary(dir: string, run: string): Promise<BenchSummary | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(`${dir}/${run}/summary.json`)) as BenchSummary;
  } catch {
    return undefined;
  }
}

/** Every run that finished, newest first. */
async function finishedRuns(dir: string): Promise<string[]> {
  const runs: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isDirectory || !BENCH_RUN.test(entry.name)) continue;
      try {
        await Deno.stat(`${dir}/${entry.name}/summary.json`);
        runs.push(entry.name);
      } catch {
        // why: A run still going, or one stopped, has no summary yet.
      }
    }
  } catch {
    return [];
  }
  return runs.sort().reverse();
}

async function runAnswer(dir: string, asked: string | null): Promise<BenchRunAnswer | undefined> {
  const runs = await finishedRuns(dir);
  const run = asked ?? runs[0];
  if (run === undefined || !runs.includes(run)) return undefined;
  const summary = await readSummary(dir, run);
  if (!summary) return undefined;
  const before = runs[runs.indexOf(run) + 1];
  const previous = before === undefined ? undefined : await readSummary(dir, before);
  return { runs, summary, ...(previous ? { previous } : {}) };
}

async function* lines(path: string): AsyncIterable<string> {
  const file = await Deno.open(path);
  let rest = '';
  for await (const chunk of file.readable.pipeThrough(new TextDecoderStream())) {
    const split = (rest + chunk).split('\n');
    rest = split.pop() ?? '';
    yield* split;
  }
  if (rest) yield rest;
}

/** The rows of `run`'s dataset that `detector`'s score counts as `outcome`, the first {@linkcode BENCH_ROWS_LIMIT}. */
async function benchRows(
  dir: string,
  run: string,
  dataset: string,
  detector: Detector,
  outcome: BenchOutcome,
): Promise<BenchRow[]> {
  const found: BenchRow[] = [];
  for await (const line of lines(`${dir}/${run}/results.jsonl`)) {
    // why: Every line names its dataset first; a cheap test skips the others without parsing them.
    if (!line.includes(`"dataset":${JSON.stringify(dataset)}`)) continue;
    const row = JSON.parse(line) as BenchRow;
    if (row.dataset !== dataset) continue;
    if (outcomeFor(row, detector) !== outcome) continue;
    found.push(row);
    if (found.length === BENCH_ROWS_LIMIT) break;
  }
  return found;
}

function isOutcome(value: string | null): value is BenchOutcome {
  return BENCH_OUTCOMES.some((outcome) => outcome === value);
}

function isDetector(value: string | null): value is Detector {
  return DETECTORS.some((detector) => detector === value);
}

/**
 * Answers the bench's two paths under `base`, reading runs from `root`'s bench folder. Undefined
 * when the request is for neither.
 */
export async function answerBench(
  root: string,
  base: string,
  request: Request,
  cors: Record<string, string>,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== `${base}/bench` && url.pathname !== `${base}/bench/rows`) return undefined;
  if (request.method !== 'GET') return json(405, {}, cors);
  const dir = `${root}/${BENCH_DIR}`;
  const run = url.searchParams.get('run');
  if (run !== null && !BENCH_RUN.test(run)) return json(400, {}, cors);
  if (url.pathname === `${base}/bench`) {
    const answer = await runAnswer(dir, run);
    return answer ? json(200, answer, cors) : json(404, {}, cors);
  }
  const dataset = url.searchParams.get('dataset');
  const detector = url.searchParams.get('detector');
  const outcome = url.searchParams.get('outcome');
  if (!run || !dataset || !isDetector(detector) || !isOutcome(outcome)) return json(400, {}, cors);
  try {
    return json(200, { rows: await benchRows(dir, run, dataset, detector, outcome) }, cors);
  } catch {
    return json(404, {}, cors);
  }
}
