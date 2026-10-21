import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import {
  Cell,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  SunburstChart,
  type SunburstData,
  Tooltip,
} from 'recharts';
import { type RankedBar, RankedTip } from './RankedBars.tsx';
import { ChartFrame, FIRST_WIDTH_PX } from './TraceOverview.tsx';
import { TRACE_GAP, type TraceFill, TraceSwatch, traceFill } from './trace-patterns.tsx';

/** Height of a radial chart, in pixels. */
const RADIAL_PX = 200;
/** The solid fills in order, for rows that name none. */
const RAMP: readonly TraceFill[] = ['clear', 'shade1', 'shade2', 'shade3'];

function fillAt(fill: TraceFill | undefined, index: number): TraceFill {
  return fill ?? RAMP[index % RAMP.length] ?? 'clear';
}

/** Each row's swatch, name and value, in the order given. */
function RadialKey({
  rows,
  format,
}: {
  rows: readonly (RankedBar & { fill: TraceFill })[];
  format: (value: number) => string;
}) {
  return (
    <VStack gap={1}>
      {rows.map((row) => (
        <HStack key={row.id} gap={2} align="center" justify="between">
          <HStack gap={2} align="center">
            <TraceSwatch fill={row.fill} />
            <Text type="supporting" color="secondary">
              {row.name}
            </Text>
          </HStack>
          <Text type="supporting" hasTabularNumbers>
            {format(row.value)}
          </Text>
        </HStack>
      ))}
    </VStack>
  );
}

/**
 * One ring per row, the first outermost, each drawn round its track as far as its value goes, with
 * a key below. `max` fixes the scale, for figures such as rates that share one.
 */
export function RadialBars({
  rows,
  format,
  max,
}: {
  rows: readonly RankedBar[];
  format: (value: number) => string;
  max?: number;
}) {
  const filled = rows.map((row, index) => ({ ...row, fill: fillAt(row.fill, index) }));
  const rings = [...filled].reverse();
  return (
    <VStack gap={3}>
      <ChartFrame>
        <ResponsiveContainer
          width="100%"
          height={RADIAL_PX}
          initialDimension={{ width: FIRST_WIDTH_PX, height: RADIAL_PX }}
        >
          <RadialBarChart
            data={rings}
            innerRadius="22%"
            outerRadius="100%"
            startAngle={90}
            endAngle={-270}
            barCategoryGap={1}
            accessibilityLayer={false}
          >
            <PolarAngleAxis
              type="number"
              domain={[0, max ?? 'auto']}
              tick={false}
              axisLine={false}
            />
            <RadialBar
              dataKey="value"
              background={{ fill: 'var(--color-background-gray)' }}
              cornerRadius={4}
              stroke={TRACE_GAP}
              isAnimationActive={false}
            >
              {rings.map((row) => (
                <Cell key={row.id} fill={traceFill(row.fill)} />
              ))}
            </RadialBar>
            <Tooltip
              content={(props) => <RankedTip {...props} format={format} />}
              cursor={false}
              isAnimationActive={false}
            />
          </RadialBarChart>
        </ResponsiveContainer>
      </ChartFrame>
      <RadialKey rows={filled} format={format} />
    </VStack>
  );
}

/** One part of a {@link Sunburst}: a leaf has a value, a branch the sum of its children's. */
export interface SunburstNode {
  id: string;
  name: string;
  value?: number;
  /** Default: the trace's solid fills in turn, a child taking its parent's. */
  fill?: TraceFill;
  /** A line under the value in the part's hover card. */
  detail?: string;
  children?: SunburstNode[];
}

function total(nodes: readonly SunburstData[]): number {
  return nodes.reduce((sum, node) => sum + (node.value ?? 0), 0);
}

function sunburstPart(node: SunburstNode, fill: TraceFill): SunburstData {
  const children = node.children ? sunburstData(node.children, fill) : undefined;
  return {
    name: node.name,
    value: node.value ?? total(children ?? []),
    fill: traceFill(fill),
    detail: node.detail,
    children,
  };
}

function sunburstData(nodes: readonly SunburstNode[], inherited?: TraceFill): SunburstData[] {
  return nodes.map((node, index) =>
    sunburstPart(node, node.fill ?? inherited ?? fillAt(undefined, index)),
  );
}

/**
 * Rings of parts, the first ring the top parts and each ring further out their children, each part
 * as wide as its value. Its parts are named on hover.
 */
export function Sunburst({
  parts,
  format,
}: {
  parts: readonly SunburstNode[];
  format: (value: number) => string;
}) {
  const data: SunburstData = { name: '', children: sunburstData(parts) };
  return (
    <ChartFrame>
      <ResponsiveContainer
        width="100%"
        height={RADIAL_PX}
        initialDimension={{ width: FIRST_WIDTH_PX, height: RADIAL_PX }}
      >
        <SunburstChart
          data={data}
          innerRadius={RADIAL_PX * 0.12}
          ringPadding={2}
          stroke={TRACE_GAP}
          textOptions={{ fill: 'transparent' }}
        >
          <Tooltip
            content={(props) => <RankedTip {...props} format={format} />}
            isAnimationActive={false}
          />
        </SunburstChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
