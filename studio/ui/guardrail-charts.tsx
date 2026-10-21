import { Grid } from '@astryxdesign/core/Grid';
import { DETECTOR_META, DETECTORS, type Detector } from '@theoremjs/agents/guardrails';
import {
  ChartCard,
  ChartStat,
  RadialBars,
  type RankedBar,
  RankedBars,
  Sunburst,
  type SunburstNode,
} from '@theoremjs/react/ui';
import {
  type BenchOutcome,
  type DatasetScore,
  type DetectorScore,
  type Percentiles,
  pooledTime,
} from '../guardrail-bench.ts';
import { PROBE_BOUNDARIES, PROBE_BOUNDARY_NOTES } from '../mod.ts';

const rate = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });

function ms(value: number): string {
  return `${value.toFixed(2)} ms`;
}

/** A change in points, or nothing when there is no figure to compare with. */
function since(now: number | undefined, before: number | undefined): string | undefined {
  if (now === undefined || before === undefined) return undefined;
  const points = (now - before) * 100;
  return `${points > 0 ? '+' : ''}${points.toFixed(1)} pts since the run before`;
}

type Pool = {
  attacks: number;
  caught: number;
  benign: number;
  fired: number;
  p95?: number;
  times: Percentiles[];
  texts: number;
};

/** Detector scores summed: recall and false alarms over every text they are scored on, and the slowest p95. */
function pool(scores: readonly DetectorScore[]): Pool {
  const times = scores.flatMap((score) => (score.ms ? [score.ms] : []));
  const p95s = times.map((time) => time.p95);
  return {
    attacks: scores.reduce((sum, score) => sum + (score.attacks ?? 0), 0),
    caught: scores.reduce((sum, score) => sum + (score.caught ?? 0), 0),
    benign: scores.reduce((sum, score) => sum + score.benign, 0),
    fired: scores.reduce((sum, score) => sum + score.falseAlarms, 0),
    ...(p95s.length > 0 && { p95: Math.max(...p95s) }),
    times,
    texts: 0,
  };
}

function poolRun(scores: readonly DatasetScore[]): Pool {
  return {
    ...pool(scores.flatMap((dataset) => dataset.detectors)),
    texts: scores.reduce((sum, dataset) => sum + dataset.samples, 0),
  };
}

function ratio(part: number, whole: number): number | undefined {
  return whole === 0 ? undefined : part / whole;
}

function byDetector(scores: readonly DatasetScore[]): { detector: Detector; pool: Pool }[] {
  return DETECTORS.flatMap((detector) => {
    const here = scores.flatMap((dataset) =>
      dataset.detectors.filter((score) => score.detector === detector),
    );
    return here.length === 0 ? [] : [{ detector, pool: pool(here) }];
  });
}

function bars(
  pools: readonly { detector: Detector; pool: Pool }[],
  value: (pool: Pool) => number | undefined,
  detail: (pool: Pool) => string,
  fill?: RankedBar['fill'],
): RankedBar[] {
  return pools
    .flatMap(({ detector, pool: each }) => {
      const figure = value(each);
      return figure === undefined
        ? []
        : [
            {
              id: detector,
              name: DETECTOR_META[detector].label,
              value: figure,
              detail: detail(each),
              ...(fill && { fill }),
            },
          ];
    })
    .sort((a, b) => b.value - a.value);
}

function shown(value: number | undefined, format: (value: number) => string): string {
  return value === undefined ? '—' : format(value);
}

/** The median and mean of every detector's timing, or why there are none. */
function timeDetail(now: Pool): string[] {
  const pooled = pooledTime(now.times);
  if (!pooled) return ['One detector alone, on one dataset', 'Median and mean: from the next run'];
  return [
    `Median ≈ ${ms(pooled.median)} · mean ${ms(pooled.mean)}`,
    'Every detector alone, every text',
  ];
}

/** Texts by the boundary they cross, then by dataset. */
function textParts(scores: readonly DatasetScore[]): SunburstNode[] {
  return PROBE_BOUNDARIES.flatMap((boundary) => {
    const here = scores.filter((dataset) => dataset.boundary === boundary);
    if (here.length === 0) return [];
    const texts = here.reduce((sum, dataset) => sum + dataset.samples, 0);
    return [
      {
        id: boundary,
        name: PROBE_BOUNDARY_NOTES[boundary].label,
        detail: `${String(here.length)} datasets`,
        children: here.map((dataset) => ({
          id: dataset.dataset,
          name: dataset.dataset,
          value: dataset.samples,
          detail: `${rate.format(dataset.samples / texts)} of this boundary`,
        })),
      },
    ];
  });
}

const count = (value: number) => `${value.toLocaleString()} texts`;

/** The run in four figures, each pooled over every detector on every dataset shown. */
function RunStats({ now, before, datasets }: { now: Pool; before?: Pool; datasets: number }) {
  const recall = ratio(now.caught, now.attacks);
  const alarms = ratio(now.fired, now.benign);
  return (
    <Grid columns={{ minWidth: 140, repeat: 'fit' }} gap={2}>
      <ChartStat
        label="Recall"
        value={shown(recall, (value) => rate.format(value))}
        detail={[
          `${now.caught.toLocaleString()} of ${now.attacks.toLocaleString()} attacks`,
          since(recall, before && ratio(before.caught, before.attacks)),
        ]}
      />
      <ChartStat
        label="False alarms"
        value={shown(alarms, (value) => rate.format(value))}
        detail={[
          `${now.fired.toLocaleString()} of ${now.benign.toLocaleString()} benign texts`,
          since(alarms, before && ratio(before.fired, before.benign)),
        ]}
      />
      <ChartStat label="Slowest p95" value={shown(now.p95, ms)} detail={timeDetail(now)} />
      <ChartStat
        label="Texts read"
        value={now.texts.toLocaleString()}
        detail={`${String(datasets)} datasets`}
      />
    </Grid>
  );
}

/** A ranking in a card, headed by its first bar; nothing when there is no bar. */
function RankCard({
  title,
  rows,
  format,
  max,
}: {
  title: string;
  rows: readonly RankedBar[];
  format: (value: number) => string;
  max?: number;
}) {
  const top = rows[0];
  if (!top) return null;
  return (
    <ChartCard title={title} value={format(top.value)} note={top.name}>
      <RankedBars rows={rows} format={format} {...(max !== undefined && { max })} />
    </ChartCard>
  );
}

const percentOf = (value: number) => rate.format(value);

/** Each detector's recall as a ring, the lowest outermost. */
function RecallCard({ rows }: { rows: readonly RankedBar[] }) {
  const top = rows[0];
  if (!top) return null;
  return (
    <ChartCard
      title="Recall by detector, lowest first"
      value={percentOf(top.value)}
      note={top.name}
    >
      <RadialBars rows={rows} format={percentOf} max={1} />
    </ChartCard>
  );
}

/** Where the texts come from: the boundary each crosses on the inner ring, its dataset outside. */
function TextsCard({ scores }: { scores: readonly DatasetScore[] }) {
  const parts = textParts(scores);
  if (parts.length === 0) return null;
  return (
    <ChartCard
      title="Texts by boundary, then dataset"
      value={String(parts.length)}
      note={parts.length === 1 ? 'boundary' : 'boundaries'}
    >
      <Sunburst parts={parts} format={count} />
    </ChartCard>
  );
}

/** Each detector's recall, false alarms and p95 time, pooled over the datasets shown. */
function DetectorCharts({ scores }: { scores: readonly DatasetScore[] }) {
  const detectors = byDetector(scores);
  return (
    <Grid columns={{ minWidth: 260, repeat: 'fit' }} gap={2}>
      <RecallCard
        rows={bars(
          detectors,
          (each) => ratio(each.caught, each.attacks),
          (each) => `${String(each.caught)} of ${String(each.attacks)} attacks`,
        ).reverse()}
      />
      <TextsCard scores={scores} />
      <RankCard
        title="False alarms by detector"
        rows={bars(
          detectors,
          (each) => ratio(each.fired, each.benign),
          (each) => `${String(each.fired)} of ${String(each.benign)} benign texts`,
          'shade1',
        )}
        format={percentOf}
      />
      <RankCard
        title="p95 time by detector"
        rows={bars(
          detectors,
          (each) => each.p95,
          () => 'Its slowest dataset',
          'shade2',
        )}
        format={ms}
      />
    </Grid>
  );
}

/** The run's figures, then each detector ranked by each of them. */
export function HealthCharts({
  scores,
  previous,
}: {
  scores: readonly DatasetScore[];
  previous: readonly DatasetScore[] | undefined;
}) {
  return (
    <>
      <RunStats
        now={poolRun(scores)}
        {...(previous && { before: poolRun(previous) })}
        datasets={scores.length}
      />
      <DetectorCharts scores={scores} />
    </>
  );
}

/** One detector on one dataset in three figures. */
export function ScoreStats({ score }: { score: DetectorScore }) {
  return (
    <Grid columns={{ minWidth: 140, repeat: 'fit' }} gap={2}>
      <ChartStat
        label="Recall"
        value={shown(score.recall, percentOf)}
        detail={
          score.attacks === undefined
            ? 'This dataset does not label what it looks for'
            : `${String(score.caught)} of ${String(score.attacks)} attacks`
        }
      />
      <ChartStat
        label="False alarms"
        value={shown(score.falseAlarmRate, percentOf)}
        detail={`${String(score.falseAlarms)} of ${String(score.benign)} benign texts`}
      />
      <ChartStat
        label="p95 time alone"
        value={score.ms ? ms(score.ms.p95) : '—'}
        detail={
          score.ms
            ? [`p50 ${ms(score.ms.p50)}`, `max ${ms(score.ms.max)}`]
            : 'Timed only inside a probe turn'
        }
      />
    </Grid>
  );
}

/** The categories with the most of `outcome`, as a share of each category's texts. */
export function CategoryChart({ score, outcome }: { score: DetectorScore; outcome: BenchOutcome }) {
  if (outcome === 'caught') return null;
  const isMissed = outcome === 'missed';
  const categories = isMissed
    ? score.attacksByCategory.map((each) => ({ ...each, count: each.samples - each.fired }))
    : score.byCategory.map((each) => ({ ...each, count: each.fired }));
  const rows = categories
    .filter((each) => each.count > 0)
    .map((each) => ({
      id: each.category,
      name: each.category,
      value: each.count / each.samples,
      detail: `${String(each.count)} of ${String(each.samples)}`,
      fill: isMissed ? ('clear' as const) : ('shade1' as const),
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
  return (
    <RankCard
      title={isMissed ? 'Missed, by category' : 'False alarms, by category'}
      rows={rows}
      format={percentOf}
      max={1}
    />
  );
}
