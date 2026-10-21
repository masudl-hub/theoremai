import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { ReactNode } from 'react';
import {
  Cell,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  SunburstChart,
  type SunburstData,
  Tooltip,
} from 'recharts';
import { paintOf, type RankedBar, RankedTip } from './RankedBars.tsx';
import { ChartFrame } from './TraceOverview.tsx';
import { TRACE_GAP, type TraceFill, traceFill } from './trace-patterns.tsx';

/** Width and height of a radial chart, in pixels. */
const RADIAL_PX = 180;
/** The solid fills in order, for parts that name none. */
const RAMP: readonly TraceFill[] = ['clear', 'shade1', 'shade2', 'shade3'];

function fillAt(fill: TraceFill | undefined, index: number): TraceFill {
  return fill ?? RAMP[index % RAMP.length] ?? 'clear';
}

/** A key's mark: a small rounded square in any paint. */
function Swatch({ paint }: { paint: string }) {
  return (
    <svg aria-hidden width={10} height={10} style={{ display: 'block', flexShrink: 0 }}>
      <rect width={10} height={10} rx={2} fill={paint} />
    </svg>
  );
}

/** Each row's mark, name and value, in the order given. */
function RadialKey({
  rows,
  format,
}: {
  rows: readonly { id: string; name: string; value: number; paint: string }[];
  format: (value: number) => string;
}) {
  return (
    <VStack gap={1}>
      {rows.map((row) => (
        <HStack key={row.id} gap={2} align="center" justify="between">
          <HStack gap={2} align="center">
            <Swatch paint={row.paint} />
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

/** A radial chart, centred, beside its key. */
function RadialFrame({ chart, keyed }: { chart: ReactNode; keyed: ReactNode }) {
  return (
    <HStack gap={4} align="center" wrap="wrap">
      <ChartFrame>{chart}</ChartFrame>
      <div style={{ flex: '1 1 140px', minWidth: 0 }}>{keyed}</div>
    </HStack>
  );
}

/**
 * One ring per row, the first outermost, each drawn round its track as far as its value goes, with
 * a key beside it in the same order. `max` fixes the scale, for figures such as rates that share one.
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
  const painted = rows.map((row, index) => ({
    ...row,
    paint: paintOf(row, fillAt(row.fill, index)),
  }));
  const rings = [...painted].reverse();
  return (
    <RadialFrame
      chart={
        <RadialBarChart
          width={RADIAL_PX}
          height={RADIAL_PX}
          data={rings}
          innerRadius="22%"
          outerRadius="100%"
          startAngle={90}
          endAngle={-270}
          barCategoryGap={1}
          accessibilityLayer={false}
        >
          <PolarAngleAxis type="number" domain={[0, max ?? 'auto']} tick={false} axisLine={false} />
          <RadialBar
            dataKey="value"
            background={{ fill: 'var(--color-background-gray)' }}
            cornerRadius={4}
            stroke={TRACE_GAP}
            isAnimationActive={false}
          >
            {rings.map((row) => (
              <Cell key={row.id} fill={row.paint} />
            ))}
          </RadialBar>
          <Tooltip
            content={(props) => <RankedTip {...props} format={format} />}
            cursor={false}
            isAnimationActive={false}
          />
        </RadialBarChart>
      }
      keyed={<RadialKey rows={painted} format={format} />}
    />
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
    id: node.id,
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
 * Rings of parts, the inner ring the top parts and each ring further out their children, each part
 * as wide as its share, with the top parts keyed beside it. Every part is named on hover.
 */
export function Sunburst({
  parts,
  format,
}: {
  parts: readonly SunburstNode[];
  format: (value: number) => string;
}) {
  const top = sunburstData(parts);
  return (
    <RadialFrame
      chart={
        <SunburstChart
          width={RADIAL_PX}
          height={RADIAL_PX}
          data={{ name: '', children: top }}
          innerRadius={RADIAL_PX * 0.11}
          ringPadding={2}
          stroke={TRACE_GAP}
          textOptions={{ fill: 'transparent' }}
        >
          <Tooltip
            content={(props) => <RankedTip {...props} format={format} />}
            isAnimationActive={false}
          />
        </SunburstChart>
      }
      keyed={
        <RadialKey
          rows={top.map((part) => ({
            id: String(part.id),
            name: part.name,
            value: part.value ?? 0,
            paint: String(part.fill),
          }))}
          format={format}
        />
      }
    />
  );
}
