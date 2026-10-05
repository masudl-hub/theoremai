import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Grid } from '@astryxdesign/core/Grid';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { IconArrowLeft, IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { TRACE_FIELDS, traceAttributeMeta } from '@theoremjs/agents';
import { type ReactNode, useEffect, useRef } from 'react';
import { isCallTrace, type TraceLatency, type TraceTurn } from '../client/trace-story.ts';
import type { TraceTotals } from '../client/trace-view.ts';
import { useTraceFormat } from './TraceValues.tsx';
import { TRACE_HUE } from './trace-palette.ts';

/** Width a chart draws at before it has measured its column: the panel's narrowest. */
export const FIRST_WIDTH_PX = 280;

/**
 * Holds a chart. Recharts makes its layers focusable, so a click would move
 * focus into the SVG and draw the browser's ring; a press here keeps focus
 * where it was. Clicks and pointer drags still reach the chart.
 */
export function ChartFrame({ children }: { children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = frame.current;
    // why: A native listener keeps the frame a plain element; it is not a control, so it takes no role.
    const keepFocus = (event: MouseEvent) => event.preventDefault();
    node?.addEventListener('mousedown', keepFocus);
    return () => node?.removeEventListener('mousedown', keepFocus);
  }, []);
  return <div ref={frame}>{children}</div>;
}

/** A chart's hover card, drawn like Astryx's own tooltip. */
export function ChartTip({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--color-background-popover)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-element)',
        padding: '6px 8px',
        boxShadow: 'var(--shadow-med)',
        pointerEvents: 'none',
      }}
    >
      {children}
    </div>
  );
}

/** Which turn is open: its name, and the previous and next turn. */
export function TurnPicker({
  turns,
  index,
  onChange,
  onBack,
}: {
  turns: readonly TraceTurn[];
  index: number;
  onChange: (index: number) => void;
  /** Leaves the turn for the whole conversation; absent when there is only the one turn. */
  onBack?: (() => void) | undefined;
}) {
  const { t } = useTraceFormat();
  const turn = turns[index];
  if (!turn) return null;
  const isCalls = isCallTrace(turns);
  return (
    <VStack gap={1} hAlign="start">
      {onBack ? (
        <Button
          label={t(
            isCalls ? '@theorem.panel.trace.calls.back' : '@theorem.panel.trace.conversation.back',
          )}
          variant="ghost"
          size="sm"
          icon={<Icon icon={IconArrowLeft} />}
          onClick={onBack}
        />
      ) : null}
      <HStack gap={1} align="center" justify="between" width="100%">
        <HStack gap={2} align="center">
          <Text weight="semibold">
            {t('@theorem.panel.trace.turn', {
              label: turn.node.meta.label,
              index: index + 1,
              count: turns.length,
            })}
          </Text>
          {turn.node.meta.subject ? (
            <Text color="secondary" maxLines={1}>
              {turn.node.meta.subject}
            </Text>
          ) : null}
        </HStack>
        <HStack gap={0}>
          <IconButton
            label={t(
              isCalls ? '@theorem.panel.trace.calls.previous' : '@theorem.panel.trace.previous',
            )}
            icon={<Icon icon={IconChevronLeft} />}
            variant="ghost"
            size="sm"
            isDisabled={index === 0}
            onClick={() => onChange(index - 1)}
          />
          <IconButton
            label={t(isCalls ? '@theorem.panel.trace.calls.next' : '@theorem.panel.trace.next')}
            icon={<Icon icon={IconChevronRight} />}
            variant="ghost"
            size="sm"
            isDisabled={index === turns.length - 1}
            onClick={() => onChange(index + 1)}
          />
        </HStack>
      </HStack>
    </VStack>
  );
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode | readonly ReactNode[];
}) {
  return (
    <Card padding={3} variant="muted" style={{ background: 'var(--color-background-surface)' }}>
      <VStack gap={1}>
        <Text type="supporting" color="secondary">
          {label}
        </Text>
        <Text type="large" weight="semibold" hasTabularNumbers>
          {value}
        </Text>
        <VStack gap={0}>
          {[detail]
            .flat()
            .filter(Boolean)
            .map((line) => (
              <Text key={String(line)} type="supporting" color="secondary" hasTabularNumbers>
                {line}
              </Text>
            ))}
        </VStack>
      </VStack>
    </Card>
  );
}

type Format = ReturnType<typeof useTraceFormat>;

function FirstTextStat({ latency, format }: { latency: TraceLatency | undefined; format: Format }) {
  if (latency?.firstTextMs === undefined) return null;
  const { t } = format;
  return (
    <Stat
      label={t('@theorem.panel.trace.firstText')}
      value={format.duration(latency.firstTextMs)}
      detail={[
        latency.tokensPerSecond !== undefined &&
          t('@theorem.panel.trace.rate', {
            rate: format.number(Math.round(latency.tokensPerSecond)),
          }),
        latency.heldMs &&
          t('@theorem.panel.trace.held', { duration: format.duration(latency.heldMs) }),
      ]}
    />
  );
}

function CostStat({ totals, format }: { totals: TraceTotals; format: Format }) {
  if (!totals.cost) return null;
  return (
    <Stat
      label={traceAttributeMeta('theorem.usage.cost_usd')?.label ?? ''}
      value={format.sum(totals.cost, format.usd)}
    />
  );
}

/** A token total as its card reads it: "–" when no call reported it. */
function tokenSide(total: TraceTotals['input'], format: Format): string {
  return total ? format.sum(total, format.number) : '–';
}

function TokensStat({ totals, format }: { totals: TraceTotals; format: Format }) {
  const { input, output } = totals;
  if (!input && !output) return null;
  const all = [input, output].reduce((sum, total) => sum + (total?.value ?? 0), 0);
  return (
    <Stat
      label={format.t('@theorem.panel.trace.tokens')}
      value={format.number(all)}
      detail={format.t('@theorem.panel.trace.tokens.detail', {
        input: tokenSide(input, format),
        output: tokenSide(output, format),
      })}
    />
  );
}

function StepsStat({
  totals,
  tools,
  format,
}: {
  totals: TraceTotals;
  tools: number;
  format: Format;
}) {
  const { t } = format;
  // why: With no model, every step is a tool call the heading already counts.
  if (totals.calls === 0 && totals.errors === 0) return null;
  return (
    <Stat
      label={t('@theorem.panel.trace.steps')}
      value={format.number(totals.calls + tools)}
      detail={
        totals.errors > 0 ? (
          <span style={{ color: TRACE_HUE.oxblood }}>
            {t('@theorem.panel.trace.failed', { count: totals.errors })}
          </span>
        ) : (
          t('@theorem.panel.trace.steps.detail', { calls: totals.calls, tools })
        )
      }
    />
  );
}

function GuardrailsStat({
  latency,
  format,
}: {
  latency: TraceLatency | undefined;
  format: Format;
}) {
  const guardrails = latency?.guardrails;
  if (!guardrails) return null;
  return (
    <Stat
      label={format.t('@theorem.panel.trace.guardrails')}
      value={format.duration(guardrails.ms)}
      detail={format.t('@theorem.panel.trace.guardrails.detail', {
        checks: guardrails.checks,
        flagged: guardrails.flagged,
      })}
    />
  );
}

/**
 * Duration, first text, cost, tokens, steps and guardrails of the open turn;
 * a total the trace did not record is left out.
 */
export function TurnStats({
  totals,
  tools,
  latency,
}: {
  totals: TraceTotals;
  tools: number;
  latency?: TraceLatency;
}) {
  const format = useTraceFormat();
  return (
    <Grid columns={{ minWidth: 120, repeat: 'fit' }} gap={2}>
      <Stat label={TRACE_FIELDS.duration.label} value={format.duration(totals.durationMs)} />
      <FirstTextStat latency={latency} format={format} />
      <CostStat totals={totals} format={format} />
      <TokensStat totals={totals} format={format} />
      <StepsStat totals={totals} tools={tools} format={format} />
      <GuardrailsStat latency={latency} format={format} />
    </Grid>
  );
}
