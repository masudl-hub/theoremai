import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartFrame, ChartTip, FIRST_WIDTH_PX } from './TraceOverview.tsx';
import { TRACE_GAP, TRACE_RADIUS, type TraceFill, traceFill } from './trace-patterns.tsx';

/** One bar of {@link RankedBars}. */
export interface RankedBar {
  id: string;
  name: string;
  value: number;
  /** Default `clear`. */
  fill?: TraceFill;
  /** A line under the value in the bar's hover card. */
  detail?: string;
}

/** Height of one bar's row, in pixels. */
const ROW_PX = 22;
/** Longest name the axis shows whole; the hover card shows the rest. */
const NAME_CHARS = 15;
const TICK = { fill: 'var(--color-text-secondary)', fontSize: 11 } as const;

function RankedTip({
  active,
  payload,
  format,
}: TooltipContentProps & { format: (value: number) => string }) {
  const row = payload?.[0]?.payload as RankedBar | undefined;
  if (!active || !row) return null;
  return (
    <ChartTip>
      <VStack gap={0}>
        <Text weight="medium">{row.name}</Text>
        <Text type="supporting" hasTabularNumbers>
          {format(row.value)}
        </Text>
        {row.detail ? (
          <Text type="supporting" color="secondary" hasTabularNumbers>
            {row.detail}
          </Text>
        ) : null}
      </VStack>
    </ChartTip>
  );
}

/**
 * Bars in the order given, one per row, named on the left and valued on the right, drawn like the
 * trace's charts. `max` fixes the scale, for figures such as rates that share one; a bar opens
 * `onSelect` when given.
 */
export function RankedBars({
  rows,
  format,
  max,
  onSelect,
}: {
  rows: readonly RankedBar[];
  format: (value: number) => string;
  max?: number;
  onSelect?: (row: RankedBar) => void;
}) {
  const height = rows.length * ROW_PX;
  return (
    <ChartFrame>
      <ResponsiveContainer
        width="100%"
        height={height}
        initialDimension={{ width: FIRST_WIDTH_PX, height }}
      >
        <BarChart
          data={[...rows]}
          layout="vertical"
          margin={{ top: 0, right: 48, bottom: 0, left: 0 }}
          accessibilityLayer={false}
          barCategoryGap={5}
          onClick={(state) => {
            const row = rows[Number(state?.activeIndex)];
            if (row && onSelect) onSelect(row);
          }}
          style={onSelect ? { cursor: 'pointer' } : undefined}
        >
          <XAxis type="number" hide domain={[0, max ?? 'auto']} />
          <YAxis
            type="category"
            dataKey="id"
            width={104}
            tick={TICK}
            tickLine={false}
            axisLine={false}
            interval={0}
            tickFormatter={(id: string) => {
              const name = rows.find((row) => row.id === id)?.name ?? '';
              return name.length > NAME_CHARS ? `${name.slice(0, NAME_CHARS - 1)}…` : name;
            }}
          />
          <Tooltip
            content={(props) => <RankedTip {...props} format={format} />}
            cursor={false}
            isAnimationActive={false}
          />
          <Bar
            dataKey="value"
            radius={TRACE_RADIUS}
            stroke={TRACE_GAP}
            strokeWidth={2}
            isAnimationActive={false}
            minPointSize={2}
            label={{
              position: 'right',
              fill: 'var(--color-text-secondary)',
              fontSize: 11,
              formatter: (value) => format(Number(value)),
            }}
          >
            {rows.map((row) => (
              <Cell key={row.id} fill={traceFill(row.fill ?? 'clear')} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
