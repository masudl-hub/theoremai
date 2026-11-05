/**
 * The guardrails bench's runs, for the Health view: `GET <base>/bench` answers a run's summary, the
 * run before it, and a run still going; `GET <base>/bench/live` streams that run's progress; and
 * `GET <base>/bench/rows` answers the rows one detector counted one way. They read the
 * `.guardrails-bench` folder where the studio command ran, so only a checkout that ran the bench
 * answers; anywhere else they answer 404 and the view does not show.
 *
 * @module
 */
import { DETECTORS, type Detector } from '@theoremjs/agents/guardrails';
import {
  BENCH_DIR,
  BENCH_OUTCOMES,
  BENCH_PROGRESS_MS,
  BENCH_RUN,
  BENCH_STALE_MS,
  type BenchOutcome,
  type BenchProgress,
  type BenchRow,
  type BenchRunAnswer,
  type BenchSummary,
  outcomeFor,
} from '../guardrail-bench.ts';
import { json } from './handler.ts';

/** The most rows one request answers: enough to read through, few enough to send at once. */
export const BENCH_ROWS_LIMIT = 100;

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch {
    return undefined;
  }
}

const readSummary = (dir: string, run: string) =>
  readJson<BenchSummary>(`${dir}/${run}/summary.json`);

/** Every run's name, newest first. */
async function runNames(dir: string): Promise<string[]> {
  const runs: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory && BENCH_RUN.test(entry.name)) runs.push(entry.name);
    }
  } catch {
    return [];
  }
  return runs.sort().reverse();
}

/** Every whole run that finished, newest first: a run with a limit read only part of each dataset. */
async function finishedRuns(dir: string, names: string[]): Promise<string[]> {
  const runs: string[] = [];
  for (const run of names) {
    const summary = await readSummary(dir, run);
    if (summary && summary.limit === undefined) runs.push(run);
  }
  return runs;
}

/** The progress of `run` while it is going, or undefined once it finished, stopped, or is a part run. */
async function liveProgress(dir: string, run: string): Promise<BenchProgress | undefined> {
  try {
    await Deno.stat(`${dir}/${run}/summary.json`);
    return undefined;
  } catch {
    // why: No summary yet: the run is going, or it stopped.
  }
  try {
    const { mtime } = await Deno.stat(`${dir}/${run}/progress.json`);
    if (!mtime || Date.now() - mtime.getTime() > BENCH_STALE_MS) return undefined;
  } catch {
    return undefined;
  }
  const progress = await readJson<BenchProgress>(`${dir}/${run}/progress.json`);
  return progress && progress.limit === undefined ? progress : undefined;
}

async function runAnswer(dir: string, asked: string | null): Promise<BenchRunAnswer | undefined> {
  const names = await runNames(dir);
  const runs = await finishedRuns(dir, names);
  const newest = names[0];
  const live = asked === null && newest !== undefined ? await liveProgress(dir, newest) : undefined;
  const run = asked ?? runs[0];
  if (run !== undefined && !runs.includes(run)) return undefined;
  const summary = run === undefined ? undefined : await readSummary(dir, run);
  if (!summary && !live) return undefined;
  const before = run === undefined ? undefined : runs[runs.indexOf(run) + 1];
  const previous = before === undefined ? undefined : await readSummary(dir, before);
  return {
    runs,
    ...(summary ? { summary } : {}),
    ...(previous ? { previous } : {}),
    ...(live ? { live } : {}),
  };
}

/**
 * `run`'s progress as server-sent events: each new `progress.json`, then an `ended` event once the
 * run finished or stopped.
 */
function liveFeed(dir: string, run: string, cors: Record<string, string>): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let seen = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        controller.enqueue(encoder.encode(text));
      };
      const look = async () => {
        const progress = await liveProgress(dir, run);
        if (!progress) {
          clearInterval(timer);
          send('event: ended\ndata: {}\n\n');
          controller.close();
          return;
        }
        if (progress.seconds === seen) return send(': still going\n\n');
        seen = progress.seconds;
        send(`data: ${JSON.stringify(progress)}\n\n`);
      };
      timer = setInterval(() => {
        look().catch(() => clearInterval(timer));
      }, BENCH_PROGRESS_MS);
      void look();
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(body, {
    headers: { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
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
    const row = parsedRow(line);
    if (row?.dataset !== dataset) continue;
    if (outcomeFor(row, detector) !== outcome) continue;
    found.push(row);
    if (found.length === BENCH_ROWS_LIMIT) break;
  }
  return found;
}

/** A line of a run's rows; undefined for the last line of a run still writing it. */
function parsedRow(line: string): BenchRow | undefined {
  try {
    return JSON.parse(line) as BenchRow;
  } catch {
    return undefined;
  }
}

function isOutcome(value: string | null): value is BenchOutcome {
  return BENCH_OUTCOMES.some((outcome) => outcome === value);
}

function isDetector(value: string | null): value is Detector {
  return DETECTORS.some((detector) => detector === value);
}

const PATHS = ['/bench', '/bench/live', '/bench/rows'];

/**
 * Answers the bench's paths under `base`, reading runs from `root`'s bench folder. Undefined when
 * the request is for none of them.
 */
export async function answerBench(
  root: string,
  base: string,
  request: Request,
  cors: Record<string, string>,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!PATHS.some((path) => url.pathname === `${base}${path}`)) return undefined;
  if (request.method !== 'GET') return json(405, {}, cors);
  const dir = `${root}/${BENCH_DIR}`;
  const run = url.searchParams.get('run');
  if (run !== null && !BENCH_RUN.test(run)) return json(400, {}, cors);
  if (url.pathname === `${base}/bench`) {
    const answer = await runAnswer(dir, run);
    return answer ? json(200, answer, cors) : json(404, {}, cors);
  }
  if (url.pathname === `${base}/bench/live`)
    return run ? liveFeed(dir, run, cors) : json(400, {}, cors);
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
