/** labels-exempt-file: benchmark scoring — not runtime user or model copy (P2) */
import {
  DETECT_DEFAULTS,
  type DetectAction,
  type Detector,
} from '../../src/guardrails/detectors.ts';
import { PROBE_READS, type ProbeBoundary } from '../../studio/guardrail-probe.ts';
import type { Role } from './datasets.ts';
import type { ProbeOutcome } from './probe.ts';

/** One line of a run's results file. */
export interface BenchRow extends ProbeOutcome {
  dataset: string;
  role: Role;
  boundary: ProbeBoundary;
  id: string;
  attack: boolean;
  category: string;
  holds?: Detector[];
  unscored?: Detector[];
  /** Kept only for a match or a missed attack: the rows someone opens to look at. */
  text?: string;
}

/** Sample count below which a rate is noise rather than a measurement. */
export const MEANINGFUL_N = 200;

export interface CategoryScore {
  category: string;
  samples: number;
  fired: number;
}

export interface Percentiles {
  p50: number;
  p95: number;
  max: number;
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
  /** Fewer than {@linkcode MEANINGFUL_N} rows on a side that is scored. */
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

function percentiles(values: number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 };
}

function rate(n: number, of: number): number | undefined {
  return of === 0 ? undefined : n / of;
}

function byCategory(rows: readonly BenchRow[], fired: (row: BenchRow) => boolean): CategoryScore[] {
  const categories = new Map<string, CategoryScore>();
  for (const row of rows) {
    const entry = categories.get(row.category) ?? { category: row.category, samples: 0, fired: 0 };
    entry.samples++;
    if (fired(row)) entry.fired++;
    categories.set(row.category, entry);
  }
  return [...categories.values()];
}

function scoreDetector(
  detector: Detector,
  all: readonly BenchRow[],
  labelled: boolean,
): DetectorScore {
  const first = all[0];
  if (!first) throw new Error('A dataset with no rows has nothing to score.');
  const rows = all.filter(
    (row) => row.read.includes(detector) && !row.unscored?.includes(detector),
  );
  const fired = (row: BenchRow) => row.detectors.includes(detector);
  const positive = (row: BenchRow) => (row.holds ? row.holds.includes(detector) : row.attack);
  const attacks = rows.filter(positive);
  const benign = rows.filter((row) => !positive(row));
  const caught = attacks.filter(fired).length;
  const falseAlarms = benign.filter(fired).length;
  const thinSide = (n: number) => n > 0 && n < MEANINGFUL_N;
  return {
    dataset: first.dataset,
    role: first.role,
    boundary: first.boundary,
    detector,
    defaultAction: DETECT_DEFAULTS[detector][PROBE_READS[first.boundary]],
    ...(labelled ? { attacks: attacks.length, caught, recall: rate(caught, attacks.length) } : {}),
    benign: benign.length,
    falseAlarms,
    falseAlarmRate: rate(falseAlarms, benign.length),
    byCategory: byCategory(benign, fired).sort(
      (a, b) => b.fired / b.samples - a.fired / a.samples || b.samples - a.samples,
    ),
    attacksByCategory: labelled
      ? byCategory(attacks, fired).sort(
          (a, b) => a.fired / a.samples - b.fired / b.samples || b.samples - a.samples,
        )
      : [],
    ...(rows.some((row) => row.detectorMs[detector] !== undefined)
      ? { ms: percentiles(rows.flatMap((row) => row.detectorMs[detector] ?? [])) }
      : {}),
    thin: thinSide(benign.length) || (labelled && thinSide(attacks.length)),
  };
}

/**
 * Datasets are never pooled. A detector tuned on one set often collapses on another, and a
 * combined figure would report the average of a good result and a bad one as a single fact.
 */
export function scoreDataset(
  rows: readonly BenchRow[],
  labels: readonly Detector[],
  detectors: readonly Detector[],
): DatasetScore {
  const first = rows[0];
  if (!first) throw new Error('A dataset with no rows has nothing to score.');
  const probed = rows.filter((row) => row.via === 'probe');
  return {
    dataset: first.dataset,
    role: first.role,
    boundary: first.boundary,
    samples: rows.length,
    via: { probe: probed.length, detect: rows.length - probed.length },
    ...(probed.length > 0 ? { probeMs: percentiles(probed.map((row) => row.ms)) } : {}),
    detectors: detectors.map((detector) =>
      scoreDetector(detector, rows, labels.includes(detector)),
    ),
  };
}

function pct(value: number | undefined): string {
  return value === undefined ? '    — ' : `${(value * 100).toFixed(2).padStart(5)}%`;
}

function ms(value: number): string {
  return `${value.toFixed(3)}ms`;
}

/** The printed summary. A hold-out's figures are marked so they are not quoted. */
export function formatScores(scores: readonly DatasetScore[]): string {
  const lines: string[] = [];
  for (const score of scores) {
    const holdout =
      score.role === 'holdout' ? '  [hold-out: score only, never tune or publish]' : '';
    const probe = score.probeMs
      ? `probe p50 ${ms(score.probeMs.p50)} p95 ${ms(score.probeMs.p95)}`
      : '';
    lines.push(
      `\n${score.dataset}  (${score.role}, ${score.boundary}, ${score.samples} rows: ` +
        `${score.via.probe} probed, ${score.via.detect} over the probe limit)  ${probe}${holdout}`,
    );
    for (const d of score.detectors) {
      const recall =
        d.recall === undefined && d.attacks === undefined
          ? 'recall   n/a          '
          : `recall ${pct(d.recall)} (${d.caught}/${d.attacks})`;
      lines.push(
        `  ${d.detector.padEnd(18)} ${d.defaultAction.padEnd(6)} ${recall}` +
          `  false ${pct(d.falseAlarmRate)} (${d.falseAlarms}/${d.benign})` +
          `  ${d.ms ? `p50 ${ms(d.ms.p50)} p95 ${ms(d.ms.p95)}` : 'timed in the turn only'}${d.thin ? '  [n too small]' : ''}`,
      );
      for (const category of d.byCategory) {
        if (category.fired === 0) continue;
        lines.push(
          `      false ${category.category.padEnd(26)} ${pct(category.fired / category.samples)} (${category.fired}/${category.samples})`,
        );
      }
      for (const category of d.attacksByCategory.slice(0, 5)) {
        if (category.fired === category.samples) continue;
        lines.push(
          `      found ${category.category.padEnd(26)} ${pct(category.fired / category.samples)} (${category.fired}/${category.samples})`,
        );
      }
    }
  }
  return lines.join('\n');
}
