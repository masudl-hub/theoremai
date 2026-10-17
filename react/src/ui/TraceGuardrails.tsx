import { Icon } from '@astryxdesign/core/Icon';
import { Item } from '@astryxdesign/core/Item';
import { Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import { Tooltip as HoverTip } from '@astryxdesign/core/Tooltip';
import { VStack } from '@astryxdesign/core/VStack';
import {
  IconBiohazard,
  IconEyeOff,
  IconHandStop,
  IconInfoCircle,
  IconShield,
} from '@tabler/icons-react';
import { TOOL_RULES } from '@theoremjs/agents/guardrails';
import type { TraceGuardrailCheck, TraceGuardrailHit } from '../client/trace-story.ts';
import type { TraceNode } from '../client/trace-view.ts';
import { Arrive, Stream } from './arrive.tsx';
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

/** What a check did, as a token. A report of a call made after a remote read says so in place of "flagged". */
function ActionToken({ check, format }: { check: TraceGuardrailCheck; format: Format }) {
  if (check.action === 'block') {
    return (
      <Token label={check.actionLabel} color="red" icon={<Icon icon={IconHandStop} size="sm" />} />
    );
  }
  if (check.action === 'redact') {
    return (
      <Token label={check.actionLabel} color="orange" icon={<Icon icon={IconEyeOff} size="sm" />} />
    );
  }
  const rules = new Set(check.hits.map((hit) => hit.rule));
  if (rules.has(TOOL_RULES.steeredTurn) || rules.has(TOOL_RULES.taintedTurn)) {
    return (
      <Token
        label={format.t(
          rules.has(TOOL_RULES.steeredTurn)
            ? '@theorem.panel.trace.guardrails.steered'
            : '@theorem.panel.trace.guardrails.tainted',
        )}
        color="yellow"
        icon={<Icon icon={IconBiohazard} size="sm" />}
      />
    );
  }
  return (
    <Token label={check.actionLabel} color="blue" icon={<Icon icon={IconInfoCircle} size="sm" />} />
  );
}

function ActedCheck({
  check,
  format,
  onSelect,
}: {
  check: TraceGuardrailCheck;
  format: Format;
  onSelect?: ((node: TraceNode) => void) | undefined;
}) {
  return (
    <Item
      startContent={<Icon icon={IconShield} size="sm" color="secondary" />}
      label={
        <HoverTip content={check.actionDoc ?? check.actionLabel}>
          <ActionToken check={check} format={format} />
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
      {...(onSelect ? { onClick: () => onSelect(check.node) } : {})}
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
  /** Opens a check's step; without it a check is not a button. */
  onSelect?: (node: TraceNode) => void;
}) {
  const format = useTraceFormat();
  const acted = checks.filter((check) => check.action !== 'allow');
  const passed = passSummary(
    checks.filter((check) => check.action === 'allow'),
    format,
  );
  return (
    <Stream>
      <VStack gap={1}>
        {acted.map((check) => (
          <Arrive key={check.id}>
            <ActedCheck check={check} format={format} onSelect={onSelect} />
          </Arrive>
        ))}
        {passed ? (
          <Arrive>
            <Text type="supporting" color="secondary" hasTabularNumbers>
              {format.t('@theorem.panel.trace.guardrails.passed', { checks: passed })}
            </Text>
          </Arrive>
        ) : null}
      </VStack>
    </Stream>
  );
}
