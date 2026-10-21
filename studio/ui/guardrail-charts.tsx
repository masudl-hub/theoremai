import { Grid } from '@astryxdesign/core/Grid';
import { DETECTOR_META, DETECTORS, type Detector } from '@theoremjs/agents/guardrails';
import { ChartCard, ChartStat, type RankedBar, RankedBars } from '@theoremjs/react/ui';
import type { BenchOutcome, DatasetScore, DetectorScore } from '../guardrail-bench.ts';

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
  texts: number;
};

/** Detector scores summed: recall and false alarms over every text they are scored on, and the slowest p95. */
function pool(scores: readonly DetectorScore[]): Pool {
  const p95s = scores.flatMap((score) => (score.ms ? [score.ms.p95] : []));
  return {
    attacks: scores.reduce((sum, score) => sum + (score.attacks ?? 0), 0),
    caught: scores.reduce((sum, score) => sum + (score.caught ?? 0), 0),
    benign: scores.reduce((sum, score) => sum + score.benign, 0),
    fired: scores.reduce((sum, score) => sum + score.falseAlarms, 0),
    ...(p95s.length > 0 && { p95: Math.max(...p95s) }),
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

/**
 * The run in four figures, each pooled over every detector on every dataset shown, and each
 * detector's recall, false alarms and p95 time beside the others.
 */
export function HealthCharts({
  scores,
  previous,
}: {
  scores: readonly DatasetScore[];
  previous: readonly DatasetScore[] | undefined;
}) {
  const now = poolRun(scores);
  const before = previous && poolRun(previous);
  const recall = ratio(now.caught, now.attacks);
  const alarms = ratio(now.fired, now.benign);
  const detectors = byDetector(scores);
  const recallBars = bars(
    detectors,
    (each) => ratio(each.caught, each.attacks),
    (each) => `${String(each.caught)} of ${String(each.attacks)} attacks`,
  ).reverse();
  const alarmBars = bars(
    detectors,
    (each) => ratio(each.fired, each.benign),
    (each) => `${String(each.fired)} of ${String(each.benign)} benign texts`,
    'shade1',
  );
  const timeBars = bars(
    detectors,
    (each) => each.p95,
    () => 'Its slowest dataset',
    'shade2',
  );
  return (
    <>
      <Grid columns={{ minWidth: 140, repeat: 'fit' }} gap={2}>
        <ChartStat
          label="Recall"
          value={recall === undefined ? '—' : rate.format(recall)}
          detail={[
            `${now.caught.toLocaleString()} of ${now.attacks.toLocaleString()} attacks`,
            since(recall, before && ratio(before.caught, before.attacks)),
          ]}
        />
        <ChartStat
          label="False alarms"
          value={alarms === undefined ? '—' : rate.format(alarms)}
          detail={[
            `${now.fired.toLocaleString()} of ${now.benign.toLocaleString()} benign texts`,
            since(alarms, before && ratio(before.fired, before.benign)),
          ]}
        />
        <ChartStat
          label="Slowest p95"
          value={now.p95 === undefined ? '—' : ms(now.p95)}
          detail="One detector alone, on one dataset"
        />
        <ChartStat
          label="Texts read"
          value={now.texts.toLocaleString()}
          detail={`${String(scores.length)} datasets`}
        />
      </Grid>
      <Grid columns={{ minWidth: 260, repeat: 'fit' }} gap={2}>
        {recallBars.length > 0 && (
          <ChartCard
            title="Recall by detector, lowest first"
            value={rate.format(recallBars[0]?.value ?? 0)}
            note={recallBars[0]?.name}
          >
            <RankedBars rows={recallBars} format={(value) => rate.format(value)} max={1} />
          </ChartCard>
        )}
        {alarmBars.length > 0 && (
          <ChartCard
            title="False alarms by detector"
            value={rate.format(alarmBars[0]?.value ?? 0)}
            note={alarmBars[0]?.name}
          >
            <RankedBars rows={alarmBars} format={(value) => rate.format(value)} />
          </ChartCard>
        )}
        {timeBars.length > 0 && (
          <ChartCard
            title="p95 time by detector"
            value={ms(timeBars[0]?.value ?? 0)}
            note={timeBars[0]?.name}
          >
            <RankedBars rows={timeBars} format={ms} />
          </ChartCard>
        )}
      </Grid>
    </>
  );
}

/** One detector on one dataset in three figures. */
export function ScoreStats({ score }: { score: DetectorScore }) {
  return (
    <Grid columns={{ minWidth: 140, repeat: 'fit' }} gap={2}>
      <ChartStat
        label="Recall"
        value={score.recall === undefined ? '—' : rate.format(score.recall)}
        detail={
          score.attacks === undefined
            ? 'This dataset does not label what it looks for'
            : `${String(score.caught)} of ${String(score.attacks)} attacks`
        }
      />
      <ChartStat
        label="False alarms"
        value={score.falseAlarmRate === undefined ? '—' : rate.format(score.falseAlarmRate)}
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
  const top = rows[0];
  if (!top) return null;
  return (
    <ChartCard
      title={isMissed ? 'Missed, by category' : 'False alarms, by category'}
      value={rate.format(top.value)}
      note={top.name}
    >
      <RankedBars rows={rows} format={(value) => rate.format(value)} max={1} />
    </ChartCard>
  );
}
