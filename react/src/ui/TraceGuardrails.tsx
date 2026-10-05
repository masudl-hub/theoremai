import { Badge } from '@astryxdesign/core/Badge';
import { Icon } from '@astryxdesign/core/Icon';
import { Item } from '@astryxdesign/core/Item';
import { Text } from '@astryxdesign/core/Text';
import { Tooltip as HoverTip } from '@astryxdesign/core/Tooltip';
import { VStack } from '@astryxdesign/core/VStack';
import { IconShield } from '@tabler/icons-react';
import type { TraceGuardrailCheck, TraceGuardrailHit } from '../client/trace-story.ts';
import type { TraceNode } from '../client/trace-view.ts';
import { useTraceFormat } from './TraceValues.tsx';

type Format = ReturnType<typeof useTraceFormat>;

/** What a check is called: the timed check's own name, or else the text it looked at. */
function checkName(check: TraceGuardrailCheck): string {
  return check.checkLabel ?? check.stageLabel;
}

/** One rule a check matched: what it caught and how serious, why that matters, and the matched text when kept. The id is on hover, for finding the rule in code. */
function HitWhy({ hit, separator }: { hit: TraceGuardrailHit; separator: string }) {
  return (
    <VStack gap={0}>
      <HoverTip content={hit.rule}>
        <Text type="supporting" weight="medium">
          {[hit.ruleLabel, hit.severityLabel].filter(Boolean).join(separator)}
        </Text>
      </HoverTip>
      {hit.ruleDoc ? (
        <Text type="supporting" color="secondary">
          {hit.ruleDoc}
        </Text>
      ) : null}
      {hit.match ? (
        <Text type="supporting" color="secondary" maxLines={2}>
          {`“${hit.match}”`}
        </Text>
      ) : null}
    </VStack>
  );
}

/** Why a check acted: which check it was and on what, each rule it matched, and the guardrail's own reason. */
function CheckWhy({ check, format }: { check: TraceGuardrailCheck; format: Format }) {
  const separator = format.t('@theorem.panel.trace.separator');
  return (
    <VStack gap={1}>
      <Text type="supporting" color="secondary" hasTabularNumbers>
        {[
          checkName(check),
          check.durationMs !== undefined && format.duration(check.durationMs),
          check.tool && format.t('@theorem.panel.trace.guardrails.from', { tool: check.tool }),
        ]
          .filter(Boolean)
          .join(separator)}
      </Text>
      {check.hits.map((hit) => (
        <HitWhy key={`${hit.rule}:${hit.match ?? ''}`} hit={hit} separator={separator} />
      ))}
      {check.reason ? (
        <Text type="supporting" color="secondary" maxLines={3}>
          {check.reason}
        </Text>
      ) : null}
    </VStack>
  );
}

function ActedCheck({
  check,
  format,
  onSelect,
}: {
  check: TraceGuardrailCheck;
  format: Format;
  onSelect: (node: TraceNode) => void;
}) {
  return (
    <Item
      startContent={<Icon icon={IconShield} size="sm" color="secondary" />}
      label={
        <HoverTip content={check.actionDoc ?? check.actionLabel}>
          <Badge
            variant={check.action === 'block' ? 'error' : 'warning'}
            label={check.actionLabel}
          />
        </HoverTip>
      }
      description={<CheckWhy check={check} format={format} />}
      endContent={
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {format.t('@theorem.panel.trace.offset', { duration: format.duration(check.offsetMs) })}
        </Text>
      }
      align="start"
      density="compact"
      onClick={() => onSelect(check.node)}
    />
  );
}

/** "Input check 0.8ms, Result check ×3 0.4ms": the passes, one entry per kind of check with its count and total time. */
function passSummary(passes: readonly TraceGuardrailCheck[], format: Format): string {
  const kinds = new Map<string, { count: number; ms: number; timed: boolean }>();
  for (const check of passes) {
    const kind = kinds.get(checkName(check)) ?? { count: 0, ms: 0, timed: false };
    kinds.set(checkName(check), {
      count: kind.count + 1,
      ms: kind.ms + (check.durationMs ?? 0),
      timed: kind.timed || check.durationMs !== undefined,
    });
  }
  return [...kinds]
    .map(([name, { count, ms, timed }]) =>
      [name, count > 1 && `×${count}`, timed && format.duration(ms)].filter(Boolean).join(' '),
    )
    .join(', ');
}

/**
 * Every guardrail check of the turn. The ones that acted lead, each with the
 * rules it matched and why; the passes follow on one quiet line.
 */
export function TraceGuardrails({
  checks,
  onSelect,
}: {
  checks: readonly TraceGuardrailCheck[];
  onSelect: (node: TraceNode) => void;
}) {
  const format = useTraceFormat();
  const acted = checks.filter((check) => check.action !== 'allow');
  const passed = passSummary(
    checks.filter((check) => check.action === 'allow'),
    format,
  );
  return (
    <VStack gap={1}>
      {acted.map((check) => (
        <ActedCheck key={check.id} check={check} format={format} onSelect={onSelect} />
      ))}
      {passed ? (
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {format.t('@theorem.panel.trace.guardrails.passed', { checks: passed })}
        </Text>
      ) : null}
    </VStack>
  );
}
