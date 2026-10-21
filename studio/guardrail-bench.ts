/**
 * What the guardrails bench (`deno task bench:guardrails`) writes: a line per text in a run's
 * `results.jsonl`, and the run's scores in `summary.json`. The bench writes these shapes and the
 * studio's Health view reads them, so both take them from here.
 *
 * @module
 */
import type { DetectAction, Detector, GuardrailEvent } from '@theoremjs/agents/guardrails';
import type { ProbeBoundary, ProbeStatus } from './guardrail-probe.ts';

/** What a dataset is for. A hold-out is scored only: nothing is tuned on it and no figure from it is published. */
export const ROLES = ['train', 'validate', 'test', 'holdout'] as const;
export type Role = (typeof ROLES)[number];

/** What one probed text came back with. */
export interface ProbeOutcome {
  status: ProbeStatus;
  /** How it was read: through a whole probe turn, or by the detectors alone when it is over the probe's limit. */
  via: 'probe' | 'detect';
  /** Theorem's detectors that matched. */
  detectors: Detector[];
  /** Every rule that fired, a detector's or the turn's own, such as a tainted call. */
  rules: string[];
  /** The whole probe turn, or the detection alone. */
  ms: number;
  /**
   * The detectors that read the text. Read alone, a text has no turn, so the detectors that read
   * against the turn's own text (the canary, the system prompt, the tool names) do not read it.
   */
  read: Detector[];
  /** Each detector of `read` but those, timed alone on the text. */
  detectorMs: Partial<Record<Detector, number>>;
  /** The guardrail events, when a detector matched. */
  events?: GuardrailEvent[];
}

/** One line of a run's results file. */
export interface BenchRow extends ProbeOutcome {
  dataset: string;
  role: Role;
  boundary: ProbeBoundary;
  id: string;
  attack: boolean;
  category: string;
  /** The detectors whose target the text holds, for a set that labels each apart. */
  holds?: Detector[];
  /** Detectors this row is left out for, because its label does not mean what the detector means. */
  unscored?: Detector[];
  /** Kept only for a match or a missed attack: the rows someone opens to look at. */
  text?: string;
}

/** Whether `row` holds what `detector` looks for. */
export function holdsTarget(row: BenchRow, detector: Detector): boolean {
  return row.holds ? row.holds.includes(detector) : row.attack;
}

/** Whether `detector` is scored on `row`: it read the text, and the row's label means what it means. */
export function isScoredFor(row: BenchRow, detector: Detector): boolean {
  return row.read.includes(detector) && !row.unscored?.includes(detector);
}

/** A row as one detector's score counts it. */
export const BENCH_OUTCOMES = ['false_alarm', 'missed', 'caught'] as const;
export type BenchOutcome = (typeof BENCH_OUTCOMES)[number];

/** How `detector`'s score counts `row`, or undefined for a benign row it passed or a row it is not scored on. */
export function outcomeFor(row: BenchRow, detector: Detector): BenchOutcome | undefined {
  if (!isScoredFor(row, detector)) return undefined;
  const fired = row.detectors.includes(detector);
  if (holdsTarget(row, detector)) return fired ? 'caught' : 'missed';
  return fired ? 'false_alarm' : undefined;
}

export interface CategoryScore {
  category: string;
  samples: number;
  fired: number;
}

export interface Percentiles {
  p50: number;
  p95: number;
  max: number;
  /** Undefined in a run from before the bench kept it. */
  mean?: number;
  /** How many timings these are. Undefined in a run from before the bench kept it. */
  n?: number;
  /**
   * The timings counted by `timeBucket`, so timings of several scores can pool. Undefined in a
   * run from before the bench kept it.
   */
  buckets?: Record<string, number>;
}

/** Buckets in each doubling of time: a bucket is about 9% wide. */
const BUCKETS_PER_DOUBLING = 8;

/** The bucket a timing in milliseconds falls in; every timing under a microsecond is bucket 0. */
export function timeBucket(ms: number): number {
  return Math.floor(Math.log2(Math.max(ms * 1000, 1)) * BUCKETS_PER_DOUBLING);
}

/** The middle of a bucket, in milliseconds. */
function bucketMs(bucket: number): number {
  return 2 ** ((bucket + 0.5) / BUCKETS_PER_DOUBLING) / 1000;
}

/**
 * The mean and median of every timing behind `times`, pooled: the mean exactly, the median to its
 * bucket. Undefined where a score has no counts.
 */
export function pooledTime(times: readonly Percentiles[]): { mean: number; median: number } | undefined {
  let total = 0;
  let sum = 0;
  const counts = new Map<number, number>();
  for (const time of times) {
    if (time.mean === undefined || time.n === undefined || !time.buckets) return undefined;
    total += time.n;
    sum += time.mean * time.n;
    for (const [bucket, count] of Object.entries(time.buckets)) {
      counts.set(Number(bucket), (counts.get(Number(bucket)) ?? 0) + count);
    }
  }
  if (total === 0) return undefined;
  let seen = 0;
  for (const bucket of [...counts.keys()].sort((a, b) => a - b)) {
    seen += counts.get(bucket) ?? 0;
    if (seen * 2 >= total) return { mean: sum / total, median: bucketMs(bucket) };
  }
  return undefined;
}

export interface DetectorScore {
  dataset: string;
  role: Role;
  boundary: ProbeBoundary;
  detector: Detector;
  /** What the detector does at this boundary when a profile sets nothing. */
  defaultAction: DetectAction;
  /** Undefined when the dataset does not label what this detector looks for. */
  attacks?: number;
  caught?: number;
  recall?: number;
  benign: number;
  falseAlarms: number;
  /** Undefined when the dataset has no benign rows. */
  falseAlarmRate?: number;
  /** Benign rows by category, those with a false alarm first. */
  byCategory: CategoryScore[];
  /** Attacks by category, the most missed first. Empty where recall is not scored. */
  attacksByCategory: CategoryScore[];
  /** Undefined for a detector that reads against the turn: it is timed only inside a probe. */
  ms?: Percentiles;
  /** Fewer rows than a rate needs on a side that is scored. */
  thin: boolean;
}

export interface DatasetScore {
  dataset: string;
  role: Role;
  boundary: ProbeBoundary;
  samples: number;
  /** Rows read by a whole probe turn, and by the detectors alone. */
  via: Record<ProbeOutcome['via'], number>;
  /** The whole probe turn, for rows read that way. */
  probeMs?: Percentiles;
  detectors: DetectorScore[];
}

/** What a run says of each dataset it read: where it crosses, what it labels, and where it is from. */
export interface BenchDatasetFacts {
  id: string;
  role: Role;
  boundary: ProbeBoundary;
  labels: readonly Detector[];
  license: string;
  attribution: string;
  /** The dataset's page. */
  source: string;
}

/** A run's `summary.json`. */
export interface BenchSummary {
  run: string;
  commit: string;
  root: string;
  corpus: string;
  limit?: number;
  seconds: number;
  profile: string;
  datasets: BenchDatasetFacts[];
  skipped: { dataset: string; reason: string }[];
  scores: DatasetScore[];
}

/**
 * A run's `progress.json`, rewritten while it runs: the datasets finished, and the one it is on,
 * scored on the rows read so far.
 */
export interface BenchProgress {
  run: string;
  limit?: number;
  seconds: number;
  datasets: BenchDatasetFacts[];
  skipped: { dataset: string; reason: string }[];
  /** The datasets finished, then the current one's rows so far. */
  scores: DatasetScore[];
  current?: { dataset: string; rows: number };
}

/** The folder the bench writes into, under the folder it ran in. */
export const BENCH_DIR = '.guardrails-bench';

/** A run's name: the time it started, as a folder name. */
export const BENCH_RUN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

/** How often a run rewrites its progress, at most. */
export const BENCH_PROGRESS_MS = 1000;

/** A run whose progress has not moved for this long has stopped. */
export const BENCH_STALE_MS = 120_000;

/**
 * What the studio server answers: the newest whole run's summary and the whole run before it, and
 * a run still going. A run with a `limit` read part of each dataset, so it is never one of these.
 */
export interface BenchRunAnswer {
  runs: string[];
  summary?: BenchSummary;
  previous?: BenchSummary;
  live?: BenchProgress;
}
