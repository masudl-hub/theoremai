import type { CorpusSample } from './corpus.ts';

export interface EvalDetector {
  id: string;
  action: 'redact' | 'block' | 'annotate';
  /**
   * A credential detector scored against a corpus of prompt injections would
   * report near-zero recall and look broken, when in fact it was asked the wrong
   * question. Recall is reported only where the corpus labels the thing the
   * detector exists to find; false-positive rate is always reported, because
   * benign is benign whatever the detector is looking for.
   */
  accountableFor: readonly string[];
  fires: (text: string) => boolean;
}

export interface CategoryScore {
  category: string;
  samples: number;
  fired: number;
  rate: number;
}

export interface DetectorScore {
  detector: string;
  action: EvalDetector['action'];
  source: string;
  attacks: number;
  attacksCaught: number;
  /** Undefined when the source carries no attacks. */
  recall?: number;
  benign: number;
  falsePositives: number;
  /** Undefined when the source carries no benign samples. */
  falsePositiveRate?: number;
  /** Benign breakdown, so one bad category cannot hide inside an average. */
  byCategory: CategoryScore[];
}

function rate(n: number, of: number): number | undefined {
  return of === 0 ? undefined : n / of;
}

function scoreDetector(
  detector: EvalDetector,
  source: string,
  samples: readonly CorpusSample[],
): DetectorScore {
  const attacks = samples.filter((s) => s.attack);
  const benign = samples.filter((s) => !s.attack);

  const accountable = detector.accountableFor.includes(source);
  const caught = attacks.filter((s) => detector.fires(s.text)).length;
  const falsePositives = benign.filter((s) => detector.fires(s.text)).length;

  const categories = new Map<string, { samples: number; fired: number }>();
  for (const sample of benign) {
    const entry = categories.get(sample.category) ?? { samples: 0, fired: 0 };
    entry.samples++;
    if (detector.fires(sample.text)) {
      entry.fired++;
    }
    categories.set(sample.category, entry);
  }

  return {
    detector: detector.id,
    action: detector.action,
    source,
    attacks: accountable ? attacks.length : 0,
    attacksCaught: accountable ? caught : 0,
    recall: accountable ? rate(caught, attacks.length) : undefined,
    benign: benign.length,
    falsePositives,
    falsePositiveRate: rate(falsePositives, benign.length),
    byCategory: [...categories.entries()]
      .map(([category, entry]) => ({
        category,
        samples: entry.samples,
        fired: entry.fired,
        rate: entry.samples === 0 ? 0 : entry.fired / entry.samples,
      }))
      .sort((a, b) => b.rate - a.rate),
  };
}

/**
 * Sources are never merged. A detector tuned on one corpus routinely collapses on
 * another, and a combined figure would report the average of a good result and a
 * bad one as though it were a single fact.
 */
function scoreAll(
  detectors: readonly EvalDetector[],
  bySource: ReadonlyMap<string, readonly CorpusSample[]>,
): DetectorScore[] {
  const out: DetectorScore[] = [];
  for (const detector of detectors) {
    for (const [source, samples] of bySource) {
      if (samples.length > 0) {
        out.push(scoreDetector(detector, source, samples));
      }
    }
  }
  return out;
}

function pct(value: number | undefined): string {
  return value === undefined ? '   —  ' : `${(value * 100).toFixed(1).padStart(5)}%`;
}

/** Sample count below which a rate is noise rather than a measurement. */
const MEANINGFUL_N = 200;

function groupScoresByDetector(scores: readonly DetectorScore[]): Map<string, DetectorScore[]> {
  const byDetector = new Map<string, DetectorScore[]>();
  for (const score of scores) {
    byDetector.set(score.detector, [...(byDetector.get(score.detector) ?? []), score]);
  }
  return byDetector;
}

function formatRecall(score: DetectorScore): string {
  if (score.recall === undefined) {
    return 'recall     n/a        ';
  }
  return `recall ${pct(score.recall)} (${score.attacksCaught}/${score.attacks})`;
}

function formatSourceLine(score: DetectorScore): string {
  const thin = score.benign > 0 && score.benign < MEANINGFUL_N ? '  [n too small]' : '';
  return (
    `  ${score.source.padEnd(24)} ${formatRecall(score)}` +
    `   false+ ${pct(score.falsePositiveRate)} (${score.falsePositives}/${score.benign})${thin}`
  );
}

function formatFiredCategories(score: DetectorScore): string[] {
  const lines: string[] = [];
  for (const category of score.byCategory) {
    if (category.fired <= 0) continue;
    lines.push(
      `      ${category.category.padEnd(22)} ${pct(category.rate)} (${category.fired}/${category.samples})`,
    );
  }
  return lines;
}

function formatScores(scores: readonly DetectorScore[]): string {
  const lines: string[] = [];
  for (const [detector, group] of groupScoresByDetector(scores)) {
    lines.push(`\n${detector}  (on fire: ${group[0]?.action ?? 'unknown'})`);
    for (const score of group) {
      lines.push(formatSourceLine(score), ...formatFiredCategories(score));
    }
  }
  return lines.join('\n');
}

export { formatScores, scoreAll, scoreDetector };
