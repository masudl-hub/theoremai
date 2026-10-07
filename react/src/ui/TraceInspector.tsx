import { Badge } from '@astryxdesign/core/Badge';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Item } from '@astryxdesign/core/Item';
import {
  type OperatorValue,
  PowerSearch,
  type PowerSearchConfig,
  type PowerSearchField,
  type PowerSearchFilter,
} from '@astryxdesign/core/PowerSearch';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { IconTimeline } from '@tabler/icons-react';
import type { TraceRecord } from '@theoremjs/agents';
import { type ReactNode, useMemo, useState } from 'react';
import type { TraceFeed } from '../client/trace-feed.ts';
import {
  isCallTrace,
  type TraceTurn,
  type TraceTurnRow,
  traceGuardrails,
  traceLatency,
  traceStory,
  traceTurnRow,
  traceTurns,
} from '../client/trace-story.ts';
import {
  TRACE_SEARCH_OPERATORS,
  TRACE_TEXT_FIELD,
  type TraceNode,
  type TraceSearchField,
  traceMatchIds,
  traceSearchFields,
  traceSpans,
  traceTotals,
  traceTree,
} from '../client/trace-view.ts';
import { useTraceRecords } from '../hooks/use-trace-records.ts';
import { Stream, useArrive } from './arrive.tsx';
import type { LabelText } from './labels.ts';
import { PaneLayout } from './SidePanel.tsx';
import { ConversationCharts, TraceCharts } from './TraceCharts.tsx';
import { TraceGuardrails } from './TraceGuardrails.tsx';
import { GuardrailStats, TurnPicker, TurnStats } from './TraceOverview.tsx';
import { TraceSpanDetail } from './TraceSpanDetail.tsx';
import { ActorMark, TraceStory } from './TraceStory.tsx';
import { useTraceFormat } from './TraceValues.tsx';
import { TraceWaterfall } from './TraceWaterfall.tsx';
import { TracePatterns } from './trace-patterns.tsx';

function unitOf(t: LabelText, field: TraceSearchField): string | undefined {
  switch (field.format) {
    case 'milliseconds':
      return t('@theorem.panel.trace.unit.milliseconds');
    case 'seconds':
      return t('@theorem.panel.trace.unit.seconds');
    case 'usd':
      return t('@theorem.panel.trace.unit.usd');
    default:
      return undefined;
  }
}

function operatorValue(t: LabelText, field: TraceSearchField): OperatorValue {
  switch (field.kind) {
    case 'options':
      return {
        type: 'enum_list',
        values: (field.options ?? []).map(({ value, label }) => ({ value, label })),
      };
    case 'number': {
      const units = unitOf(t, field);
      return units ? { type: 'float', units } : { type: 'float' };
    }
    case 'text':
      return { type: 'string', isArbitraryStringAllowed: true };
    case 'flag':
      return { type: 'empty' };
  }
}

function searchField(t: LabelText, field: TraceSearchField): PowerSearchField {
  const value = operatorValue(t, field);
  return {
    key: field.key,
    label: field.label,
    description: field.doc,
    ...(field.group && { group: field.group }),
    operators: TRACE_SEARCH_OPERATORS[field.kind].map((key) => ({
      key,
      value,
      i18nKey: `@astryx.powersearch.operator.${key}`,
    })),
  };
}

/** The search over the spans shown: any text first, then the fields the spans recorded. */
function searchConfig(t: LabelText, nodes: readonly TraceNode[]): PowerSearchConfig {
  return {
    name: t('@theorem.panel.trace.search'),
    contentSearchFieldKey: TRACE_TEXT_FIELD,
    fields: [
      searchField(t, {
        key: TRACE_TEXT_FIELD,
        label: t('@theorem.panel.trace.search.text'),
        doc: t('@theorem.panel.trace.search.text.description'),
        kind: 'text',
      }),
      ...traceSearchFields(nodes).map((field) => searchField(t, field)),
    ],
  };
}

function SectionTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <HStack gap={2} align="center" justify="between">
      <Text weight="semibold">{title}</Text>
      {children}
    </HStack>
  );
}

/** The turn open, or none for the whole conversation; a trace of one turn opens it. */
function useOpenTurn(count: number) {
  const [picked, setPicked] = useState<number | null>(null);
  const index = count === 1 ? 0 : picked !== null && picked < count ? picked : null;
  return { index, pick: setPicked };
}

/** How the row's turn ended: its failure, else its answer. */
function turnRowNote(row: TraceTurnRow): ReactNode {
  if (row.outcome) return <Badge variant={row.outcome.tone} label={row.outcome.label} />;
  if (!row.answered) return undefined;
  return (
    <Text color="secondary" maxLines={2} hasTruncateTooltip={false}>
      {row.answered}
    </Text>
  );
}

/** A row's time, and its cost when it has one. */
function TurnRowTotals({ turn }: { turn: TraceTurn }) {
  const format = useTraceFormat();
  return (
    <VStack gap={0} hAlign="end">
      <Text type="supporting" hasTabularNumbers>
        {format.duration(turn.totals.durationMs)}
      </Text>
      {turn.totals.cost ? (
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {format.sum(turn.totals.cost, format.usd)}
        </Text>
      ) : null}
    </VStack>
  );
}

/** A row of the whole-trace list: a turn by what the person asked, a host's call by its tool. */
function TurnRow({
  turn,
  index,
  isCall,
  onOpen,
}: {
  turn: TraceTurn;
  index: number;
  isCall: boolean;
  onOpen: () => void;
}) {
  const { t } = useTraceFormat();
  const arrive = useArrive();
  const row = useMemo(() => traceTurnRow(turn, isCall), [turn, isCall]);
  return (
    <Item
      className={arrive?.className}
      style={arrive?.style}
      startContent={<ActorMark actor={row.actor} />}
      label={
        <Text weight="medium" maxLines={1}>
          {row.title ??
            t(
              isCall ? '@theorem.panel.trace.charts.hostCall' : '@theorem.panel.trace.charts.turn',
              { index: index + 1 },
            )}
        </Text>
      }
      description={turnRowNote(row)}
      endContent={<TurnRowTotals turn={turn} />}
      align="start"
      density="compact"
      onClick={onOpen}
    />
  );
}

/** Every turn at once: the conversation's totals, each turn's time and tokens, and the turns themselves. */
function ConversationOverview({
  turns,
  onPick,
}: {
  turns: readonly TraceTurn[];
  onPick: (index: number) => void;
}) {
  const { t } = useTraceFormat();
  const nodes = useMemo(() => turns.map((turn) => turn.node), [turns]);
  // why: Time between turns is the person's, not the agent's: the duration sums the turns.
  const totals = useMemo(
    () => ({
      ...traceTotals(nodes),
      durationMs: turns.reduce((total, turn) => total + turn.totals.durationMs, 0),
    }),
    [nodes, turns],
  );
  const tools = useMemo(
    () => traceSpans(nodes).filter((node) => node.meta.type === 'tool').length,
    [nodes],
  );
  const isCalls = isCallTrace(turns);
  return (
    <VStack gap={5} padding={4}>
      <Text weight="semibold">
        {t(isCalls ? '@theorem.panel.trace.calls.count' : '@theorem.panel.trace.conversation', {
          count: turns.length,
        })}
      </Text>
      <VStack gap={3}>
        <TurnStats totals={totals} tools={tools} />
        <ConversationCharts turns={turns} onPick={onPick} />
      </VStack>
      <VStack gap={2}>
        <SectionTitle
          title={t(isCalls ? '@theorem.panel.trace.calls' : '@theorem.panel.trace.turns')}
        />
        <Stream>
          <VStack gap={0}>
            {turns.map((turn, index) => (
              <TurnRow
                key={turn.node.id}
                turn={turn}
                index={index}
                isCall={isCalls}
                onOpen={() => onPick(index)}
              />
            ))}
          </VStack>
        </Stream>
      </VStack>
    </VStack>
  );
}

/** One turn at a glance, then its story, then its timeline under the search. */
function TurnOverview({
  turns,
  index,
  onPick,
  onBack,
  selectedId,
  onSelect,
}: {
  turns: readonly TraceTurn[];
  index: number;
  onPick: (index: number) => void;
  onBack?: (() => void) | undefined;
  selectedId: string | undefined;
  onSelect: (node: TraceNode) => void;
}) {
  const { t } = useTraceFormat();
  const [filters, setFilters] = useState<readonly PowerSearchFilter[]>([]);
  const turn = turns[index];
  const root = turn?.node;
  const config = useMemo(() => searchConfig(t, root ? [root] : []), [t, root]);
  const matches = useMemo(
    () => (root ? traceMatchIds([root], filters) : undefined),
    [root, filters],
  );
  const story = useMemo(() => (root ? traceStory(root) : []), [root]);
  const latency = useMemo(() => (root ? traceLatency(root) : undefined), [root]);
  const guardrails = useMemo(() => (root ? traceGuardrails(root) : []), [root]);
  if (!turn || !root) return null;
  const tools = traceSpans([root]).filter((node) => node.meta.type === 'tool').length;
  return (
    <VStack gap={5} padding={4}>
      <TurnPicker turns={turns} index={index} onChange={onPick} onBack={onBack} />
      <VStack gap={3}>
        <TurnStats totals={turn.totals} tools={tools} latency={latency} />
        <TraceCharts root={root} split={turn.split} onSelect={onSelect} />
      </VStack>
      <VStack gap={2}>
        <SectionTitle title={t('@theorem.panel.trace.timeline')} />
        <PowerSearch
          config={config}
          filters={filters}
          onChange={setFilters}
          label={t('@theorem.panel.trace.search')}
          isLabelHidden
          placeholder={t('@theorem.panel.trace.search.placeholder')}
          resultCount={matches?.size}
          size="sm"
        />
        <TraceWaterfall
          key={root.id}
          root={root}
          selectedId={selectedId}
          matches={matches}
          onSelect={onSelect}
        />
      </VStack>
      {story.length > 0 ? (
        <VStack gap={2}>
          <SectionTitle title={t('@theorem.panel.trace.story')} />
          <TraceStory steps={story} selectedId={selectedId} matches={matches} onSelect={onSelect} />
        </VStack>
      ) : null}
      {guardrails.length > 0 ? (
        <VStack gap={2}>
          <SectionTitle title={t('@theorem.panel.trace.guardrails')} />
          <TraceGuardrails checks={guardrails} onSelect={onSelect} />
        </VStack>
      ) : null}
    </VStack>
  );
}

function EmptyTrace() {
  const { t } = useTraceFormat();
  return (
    <VStack height="100%" vAlign="center" padding={4}>
      <EmptyState
        icon={<Icon icon={IconTimeline} size="lg" color="secondary" />}
        title={t('@theorem.panel.trace.empty.title')}
        description={t('@theorem.panel.trace.empty.description')}
        isCompact
      />
    </VStack>
  );
}

/** The open span of the open turn; opening another turn closes it. */
function useOpenSpan(turns: readonly TraceTurn[]) {
  const { index, pick } = useOpenTurn(turns.length);
  const [openId, setOpenId] = useState<string | null>(null);
  const root = index === null ? undefined : turns[index]?.node;
  const open = openId && root ? traceSpans([root]).find((node) => node.id === openId) : undefined;
  return {
    index,
    root,
    open,
    select: (node: TraceNode) => setOpenId(node.id),
    close: () => setOpenId(null),
    pick: (next: number | null) => {
      pick(next);
      setOpenId(null);
    },
  };
}

/** The open span beside or in place of the overview; nothing while none is open. */
function SpanPane({
  open,
  turnStartMs,
  isWide,
  onBack,
  onOpen,
}: {
  open: TraceNode | undefined;
  turnStartMs: number;
  isWide: boolean;
  onBack: () => void;
  onOpen: (node: TraceNode) => void;
}) {
  if (!open) return null;
  return (
    <VStack padding={4}>
      <TraceSpanDetail
        node={open}
        turnStartMs={turnStartMs}
        isClose={isWide}
        onBack={onBack}
        onOpen={onOpen}
      />
    </VStack>
  );
}

/** The whole conversation, or the open turn with a way back when there are others. */
function Overview({
  turns,
  index,
  pick,
  selectedId,
  select,
}: {
  turns: readonly TraceTurn[];
  index: number | null;
  pick: (index: number | null) => void;
  selectedId: string | undefined;
  select: (node: TraceNode) => void;
}) {
  if (index === null) return <ConversationOverview turns={turns} onPick={pick} />;
  return (
    <TurnOverview
      turns={turns}
      index={index}
      onPick={pick}
      onBack={turns.length > 1 ? () => pick(null) : undefined}
      selectedId={selectedId}
      onSelect={select}
    />
  );
}

/**
 * The panel's content. Narrow, the turn fills it and a span opens in its
 * place; wide, an open span sits beside the turn.
 */
function TraceInspectorBody({
  records,
  isWide,
}: {
  records: readonly TraceRecord[];
  isWide: boolean;
}) {
  const tree = useMemo(() => traceTree(records), [records]);
  const turns = useMemo(() => traceTurns(tree), [tree]);
  const { t } = useTraceFormat();
  const { index, root, open, select, close, pick } = useOpenSpan(turns);
  if (turns.length === 0) return <EmptyTrace />;
  const overview = (
    <Overview turns={turns} index={index} pick={pick} selectedId={open?.id} select={select} />
  );
  return (
    <PaneLayout
      isWide={isWide}
      label={t('@theorem.panel.trace.name')}
      detailLabel={open?.meta.label ?? ''}
      lead={<TracePatterns />}
      overview={overview}
      detail={
        open && (
          <SpanPane
            open={open}
            turnStartMs={root?.startMs ?? 0}
            isWide={isWide}
            onBack={close}
            onOpen={select}
          />
        )
      }
    />
  );
}

/** The inspector over the records a feed has delivered; the panel loads this module when it first opens. */
export function TraceFeedBody({
  traces,
  isWide,
}: {
  traces: TraceFeed | undefined;
  isWide: boolean;
}) {
  return <TraceInspectorBody records={useTraceRecords(traces)} isWide={isWide} />;
}

/**
 * Only what the records say of guardrails: how long the checks took, how many
 * ran and acted, then each check. `head` leads it.
 */
export function TraceGuardrailsBody({
  records,
  head,
}: {
  records: readonly TraceRecord[];
  head?: ReactNode;
}) {
  const { t } = useTraceFormat();
  const roots = useMemo(() => traceTurns(traceTree(records)).map((turn) => turn.node), [records]);
  const checks = useMemo(() => roots.flatMap(traceGuardrails), [roots]);
  return (
    <VStack gap={5} padding={4}>
      {head}
      {roots.map((root) => (
        <GuardrailStats key={root.id} latency={traceLatency(root)} />
      ))}
      {checks.length > 0 ? (
        <VStack gap={2}>
          <SectionTitle title={t('@theorem.panel.trace.guardrails')} />
          <TraceGuardrails checks={checks} />
        </VStack>
      ) : null}
    </VStack>
  );
}
