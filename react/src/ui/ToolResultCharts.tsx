import { Grid } from '@astryxdesign/core/Grid';
import { HStack } from '@astryxdesign/core/HStack';
import { useLocale } from '@astryxdesign/core/i18n';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from 'recharts';
import { withUnit } from '../client/shaped-data.ts';
import { type ResultChart, timeFormats } from '../client/tool-result.ts';
import { ChartFrame, ChartTip, FIRST_WIDTH_PX } from './TraceOverview.tsx';
import {
  ChartCard,
  TRACE_GAP,
  TRACE_RADIUS,
  type TraceFill,
  TraceSwatch,
  traceFill,
} from './trace-patterns.tsx';

/**
 * A tool result's charts, drawn as the trace draws its own: the same card,
 * fills, ticks, and hover card. Recharts loads with this module, only when a
 * result has a chart.
 *
 * @module
 */

/** Height of a time chart's plot, in pixels. */
const CHART_PX = 140;
/** Height of one row of a ranking, in pixels. */
const BAR_ROW_PX = 22;
const TICK = { fill: 'var(--color-text-secondary)', fontSize: 11 } as const;
const BAR = {
  radius: TRACE_RADIUS,
  stroke: TRACE_GAP,
  strokeWidth: 2,
  isAnimationActive: false,
} as const;
/** Each overlaid series, in the trace's order. */
const SERIES_FILL: readonly TraceFill[] = ['clear', 'shade1', 'shade2'];

type Formats = {
  number: (value: number, unit?: string) => string;
  tick: (text: string) => string;
  when: (text: string) => string;
};

function useFormats(chart: ResultChart): Formats {
  const locale = useLocale();
  return useMemo(() => {
    const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    const number = (value: number, unit?: string) => withUnit(decimal.format(value), unit);
    const dates = chart.kind === 'time' ? chart.rows.map((row) => String(row[chart.x])) : [];
    const options = timeFormats(dates);
    const tick = new Intl.DateTimeFormat(locale, options.tick);
    const when = new Intl.DateTimeFormat(locale, options.when);
    const read = (format: Intl.DateTimeFormat) => (text: string) => {
      const at = Date.parse(text);
      return Number.isNaN(at) ? text : format.format(at);
    };
    return { number, tick: read(tick), when: read(when) };
  }, [chart, locale]);
}

type TimeChart = Extract<ResultChart, { kind: 'time' }>;
type CategoryChart = Extract<ResultChart, { kind: 'category' }>;

function TimeTip({
  active,
  payload,
  label,
  chart,
  formats,
}: TooltipContentProps & { chart: TimeChart; formats: Formats }) {
  if (!active || !payload?.length) return null;
  return (
    <ChartTip>
      <VStack gap={0}>
        <Text weight="medium">{formats.when(String(label))}</Text>
        {chart.series.map((series, index) => {
          const value = payload.find((entry) => entry.dataKey === series.key)?.value;
          return typeof value === 'number' ? (
            <HStack key={series.key} gap={2} vAlign="center">
              {chart.series.length > 1 ? (
                <TraceSwatch fill={SERIES_FILL[index] ?? 'clear'} />
              ) : null}
              <Text type="supporting" hasTabularNumbers>
                {chart.series.length > 1 ? `${series.label} ` : ''}
                {formats.number(value, series.unit)}
              </Text>
            </HStack>
          ) : null;
        })}
      </VStack>
    </ChartTip>
  );
}

/** One or more series over time: the first reading as the figure, the span of every reading as its note. */
function TimeCard({ chart }: { chart: TimeChart }) {
  const formats = useFormats(chart);
  const [lead] = chart.series;
  const values = chart.series.flatMap((series) =>
    chart.rows
      .map((row) => row[series.key])
      .filter((value): value is number => typeof value === 'number'),
  );
  const first = lead
    ? chart.rows
        .map((row) => row[lead.key])
        .find((value): value is number => typeof value === 'number')
    : undefined;
  if (!lead || first === undefined) return null;
  const unit = lead.unit;
  const range = `${formats.number(Math.min(...values))}–${formats.number(Math.max(...values), unit)}`;
  return (
    <ChartCard title={chart.title} value={formats.number(first, unit)} note={range}>
      <ChartFrame>
        <ResponsiveContainer
          width="100%"
          height={CHART_PX}
          initialDimension={{ width: FIRST_WIDTH_PX, height: CHART_PX }}
        >
          <LineChart
            data={chart.rows}
            margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
            accessibilityLayer={false}
          >
            <XAxis
              dataKey={chart.x}
              tick={TICK}
              tickLine={false}
              axisLine={false}
              tickFormatter={formats.tick}
              minTickGap={16}
            />
            <YAxis
              tick={TICK}
              tickLine={false}
              axisLine={false}
              width={36}
              domain={['auto', 'auto']}
              tickFormatter={(value: number) => formats.number(value)}
            />
            <Tooltip
              content={(props) => <TimeTip {...props} chart={chart} formats={formats} />}
              cursor={{ stroke: 'var(--color-border-emphasized)' }}
              isAnimationActive={false}
            />
            {chart.series.map((series, index) => (
              <Line
                key={series.key}
                type="monotone"
                dataKey={series.key}
                stroke={traceFill(SERIES_FILL[index] ?? 'clear')}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3, strokeWidth: 0 }}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </ChartFrame>
      {chart.series.length > 1 ? (
        <HStack gap={3} wrap="wrap">
          {chart.series.map((series, index) => (
            <HStack key={series.key} gap={2} vAlign="center">
              <TraceSwatch fill={SERIES_FILL[index] ?? 'clear'} />
              <Text type="supporting" color="secondary">
                {series.label}
              </Text>
            </HStack>
          ))}
        </HStack>
      ) : null}
    </ChartCard>
  );
}

type BarRow = CategoryChart['rows'][number] & { id: string };

function BarTip({
  active,
  payload,
  chart,
  formats,
}: TooltipContentProps & { chart: CategoryChart; formats: Formats }) {
  const row = payload?.[0]?.payload as BarRow | undefined;
  if (!active || !row) return null;
  return (
    <ChartTip>
      <VStack gap={0}>
        <Text weight="medium">{row.label}</Text>
        <Text type="supporting" hasTabularNumbers>
          {formats.number(row.value, chart.series.unit)}
        </Text>
      </VStack>
    </ChartTip>
  );
}

/** Rows ranked by one number, largest first, drawn like the trace's slowest steps. */
function CategoryCard({ chart }: { chart: CategoryChart }) {
  const formats = useFormats(chart);
  const rows = useMemo<BarRow[]>(
    () => chart.rows.map((row, index) => ({ ...row, id: String(index) })),
    [chart],
  );
  const [top] = rows;
  if (!top) return null;
  const height = rows.length * BAR_ROW_PX;
  return (
    <ChartCard
      title={chart.title}
      value={formats.number(top.value, chart.series.unit)}
      note={top.label}
    >
      <ChartFrame>
        <ResponsiveContainer
          width="100%"
          height={height}
          initialDimension={{ width: FIRST_WIDTH_PX, height }}
        >
          <BarChart
            data={rows}
            layout="vertical"
            margin={{ top: 0, right: 56, bottom: 0, left: 0 }}
            accessibilityLayer={false}
            barCategoryGap={5}
          >
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="id"
              width={104}
              tick={TICK}
              tickLine={false}
              axisLine={false}
              interval={0}
              tickFormatter={(id: string) => {
                const label = rows[Number(id)]?.label ?? '';
                return label.length > 15 ? `${label.slice(0, 14)}…` : label;
              }}
            />
            <Tooltip
              content={(props) => <BarTip {...props} chart={chart} formats={formats} />}
              cursor={{ fill: 'var(--color-overlay-hover)', radius: TRACE_RADIUS }}
              isAnimationActive={false}
            />
            <Bar
              dataKey="value"
              {...BAR}
              label={{
                position: 'right',
                fill: 'var(--color-text-secondary)',
                fontSize: 11,
                formatter: (value) => formats.number(Number(value), chart.series.unit),
              }}
            >
              {rows.map((row, index) => (
                <Cell key={row.id} fill={traceFill(index === 0 ? 'clear' : 'shade2')} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartFrame>
    </ChartCard>
  );
}

/** Each chart in its card, side by side where the column is wide enough. */
export function ToolResultCharts({ charts }: { charts: readonly ResultChart[] }) {
  return (
    <Grid columns={{ minWidth: 260, repeat: 'fill' }} gap={3}>
      {charts.map((chart) =>
        chart.kind === 'time' ? (
          <TimeCard key={chart.key} chart={chart} />
        ) : (
          <CategoryCard key={chart.key} chart={chart} />
        ),
      )}
    </Grid>
  );
}
