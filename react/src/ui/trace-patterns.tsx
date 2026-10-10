import { Card } from '@astryxdesign/core/Card';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { ReactNode } from 'react';
import type { TraceActor } from '../client/trace-story.ts';

/**
 * The trace charts' fills, one per series in order: the first is clear (a
 * solid), the second a fine hatch, and the rest shades of deep navy (#0D1E37).
 * Only a failure leaves the ramp, for oxblood. Also the card each chart
 * sits in, which decision answers share.
 *
 * @module
 */

export type TraceFill = 'clear' | 'hatch' | 'shade1' | 'shade2' | 'shade3' | 'failed';

const SOLID: Readonly<Record<Exclude<TraceFill, 'hatch'>, string>> = {
  clear: 'light-dark(#0d1e37, #b4c6e2)',
  shade1: 'light-dark(#3b5580, #6582ad)',
  shade2: 'light-dark(#7f95b7, #3b5078)',
  shade3: 'light-dark(#bcc8da, #22345a)',
  failed: 'light-dark(#8e2a28, #cd5f55)',
};
const HATCH_BASE = 'light-dark(#e4e7ec, #2b2f36)';
const HATCH_STRIPE = 'light-dark(#9aa3b1, #6b727d)';

/** Text that leads a chart's headline, in the clear series' colour. */
const TRACE_ACCENT = SOLID.clear;

/** Corner radius of every bar, in pixels. */
export const TRACE_RADIUS = 4;
/** Paints the gap between stacked segments: the chart card's own background. */
export const TRACE_GAP = 'var(--color-background-surface)';

/** Each actor's fill: the model clear, tools hatched, the rest in shades. */
export const ACTOR_FILL: Readonly<Record<TraceActor, TraceFill>> = {
  model: 'clear',
  tool: 'hatch',
  host: 'shade1',
  theorem: 'shade2',
  user: 'shade3',
  error: 'failed',
};

/** The paint for a fill; the hatch lives in {@link TracePatterns}. */
export function traceFill(fill: TraceFill): string {
  return fill === 'hatch' ? 'url(#trace-fill-hatch)' : SOLID[fill];
}

/** The hatch, once per panel; charts anywhere in the document refer to it by id. */
export function TracePatterns() {
  return (
    <svg aria-hidden width={0} height={0} style={{ position: 'absolute' }}>
      <defs>
        <pattern
          id="trace-fill-hatch"
          width={3}
          height={3}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width={3} height={3} fill={HATCH_BASE} />
          <line x1={0} y1={0} x2={0} y2={3} stroke={HATCH_STRIPE} strokeWidth={1.2} />
        </pattern>
      </defs>
    </svg>
  );
}

/** A legend's key: a small rounded square in the fill. */
export function TraceSwatch({ fill }: { fill: TraceFill }) {
  return (
    <svg aria-hidden width={10} height={10} style={{ display: 'block', flexShrink: 0 }}>
      <rect width={10} height={10} rx={2} fill={traceFill(fill)} />
    </svg>
  );
}

/** A chart as a card: its name, one figure that answers it, then the chart and its key. */
export function ChartCard({
  title,
  value,
  note,
  children,
}: {
  title: string;
  value: ReactNode;
  note?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card
      variant="muted"
      padding={4}
      style={{ background: 'var(--theorem-console-card, var(--color-background-surface))' }}
    >
      <VStack gap={3}>
        <Text type="supporting" color="secondary">
          {title}
        </Text>
        {/* why: HStack aligns boxes, not text; the figure and its note share a baseline. */}
        <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 8 }}>
          <Text size="2xl" weight="medium" hasTabularNumbers>
            {value}
          </Text>
          {note ? (
            <Text type="supporting" hasTabularNumbers>
              <span style={{ color: TRACE_ACCENT }}>{note}</span>
            </Text>
          ) : null}
        </div>
        {children}
      </VStack>
    </Card>
  );
}
