import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import {
	type OperatorValue,
	PowerSearch,
	type PowerSearchConfig,
	type PowerSearchField,
	type PowerSearchFilter,
} from '@astryxdesign/core/PowerSearch';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { IconTimeline } from '@tabler/icons-react';
import { type ReactNode, type RefObject, useMemo, useState } from 'react';
import type { ProfileObservabilityView } from '../../../src/interface/mod.ts';
import type { TraceFeed } from '../client/trace-feed.ts';
import {
	filterTraceTree,
	TRACE_SEARCH_OPERATORS,
	TRACE_TEXT_FIELD,
	type TraceNode,
	type TraceSearchField,
	type TraceTotals,
	traceSearchFields,
	traceSpans,
	traceTotals,
	traceTree,
} from '../client/trace-view.ts';
import { useTraceRecords } from '../hooks/use-trace-records.ts';
import type { LabelText } from './labels';
import { useLabels } from './labels-provider';
import { isSidePanelWide, SidePanel, SidePanelToggle, useSidePanel } from './SidePanel';
import { TraceSpanDetail } from './TraceSpanDetail';
import { TraceSpanList } from './TraceSpanList';
import { TraceSpanTable } from './TraceSpanTable';
import { type TraceFormat, useTraceFormat } from './TraceValues';

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
			return { type: 'enum_list', values: (field.options ?? []).map(({ value, label }) => ({ value, label })) };
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
		operators: TRACE_SEARCH_OPERATORS[field.kind].map((key) => ({ key, value, i18nKey: `@astryx.powersearch.operator.${key}` })),
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

/** The records' spans as a tree, cut by the filters, with the totals of what is shown. */
function useTraceView(traces: TraceFeed | undefined, filters: readonly PowerSearchFilter[]) {
	const { t } = useTraceFormat();
	const records = useTraceRecords(traces);
	const tree = useMemo(() => traceTree(records), [records]);
	const config = useMemo(() => searchConfig(t, tree), [t, tree]);
	const shown = useMemo(() => filterTraceTree(tree, filters), [tree, filters]);
	const totals = useMemo(() => traceTotals(shown.nodes), [shown]);
	return { tree, config, shown, totals };
}

/** "2 traces · 9 spans · $0.0012": the shown spans, and their cost when a call reported one. */
function summaryLine(format: TraceFormat, nodes: readonly TraceNode[], totals: TraceTotals): string {
	const traceCount = new Set(traceSpans(nodes).map((node) => node.span.traceId)).size;
	return [
		format.t('@theorem.panel.trace.summary', { traces: traceCount, spans: totals.spans }),
		...(totals.cost ? [format.sum(totals.cost, format.usd)] : []),
	].join(format.t('@theorem.panel.trace.separator'));
}

/** The shown spans: none matched, the wide table, or the slim list. */
function TraceResults({
	nodes,
	totals,
	isWide,
	onOpen,
}: {
	nodes: readonly TraceNode[];
	totals: TraceTotals;
	isWide: boolean;
	onOpen: (node: TraceNode) => void;
}) {
	const { t } = useTraceFormat();
	if (nodes.length === 0) return <EmptyState title={t('@theorem.panel.trace.no_match')} isCompact />;
	if (isWide) return <TraceSpanTable nodes={nodes} totals={totals} onOpen={onOpen} />;
	return <TraceSpanList nodes={nodes} onOpen={onOpen} />;
}

/** The panel's content: search, then the slim list or the wide table, or one span in full. */
function TraceInspectorBody({ traces, isWide }: { traces: TraceFeed | undefined; isWide: boolean }) {
	const format = useTraceFormat();
	const { t } = format;
	const [filters, setFilters] = useState<readonly PowerSearchFilter[]>([]);
	const [openId, setOpenId] = useState<string | null>(null);
	const { tree, config, shown, totals } = useTraceView(traces, filters);
	const open = openId ? traceSpans(tree).find((node) => node.id === openId) : undefined;
	const onOpen = (node: TraceNode) => setOpenId(node.id);

	if (tree.length === 0) {
		return (
			<VStack height="100%" vAlign="center" padding={3}>
				<EmptyState
					icon={<Icon icon={IconTimeline} size="lg" color="secondary" />}
					title={t('@theorem.panel.trace.empty.title')}
					description={t('@theorem.panel.trace.empty.description')}
					isCompact
				/>
			</VStack>
		);
	}
	if (open) {
		return (
			<ScrollableArea label={t('@theorem.panel.trace.name')} height="100%">
				<VStack padding={3}>
					<TraceSpanDetail node={open} onBack={() => setOpenId(null)} onOpen={onOpen} />
				</VStack>
			</ScrollableArea>
		);
	}
	return (
		<VStack height="100%" gap={2} padding={3}>
			<PowerSearch
				config={config}
				filters={filters}
				onChange={setFilters}
				label={t('@theorem.panel.trace.search')}
				isLabelHidden
				placeholder={t('@theorem.panel.trace.search.placeholder')}
				resultCount={shown.matches}
				size="sm"
			/>
			{isWide ? null : <Text type="supporting">{summaryLine(format, shown.nodes, totals)}</Text>}
			<ScrollableArea label={t('@theorem.panel.trace.name')} height="100%">
				<TraceResults nodes={shown.nodes} totals={totals} isWide={isWide} onOpen={onOpen} />
			</ScrollableArea>
		</VStack>
	);
}

/**
 * The trace inspector, offered when the profile records traces: a header
 * toggle and a Layout `end` panel, closed at first. It reads the records the
 * host delivers on `traces`; a host that delivers none shows the empty state.
 * Dragged wider than two readable columns, the slim list becomes the table.
 */
export function useTraceInspector(
	iface: { observability?: ProfileObservabilityView },
	layoutRef: RefObject<HTMLDivElement | null>,
	traces?: TraceFeed,
): { toggle: ReactNode; panel: ReactNode } {
	const t = useLabels();
	const { id, open, toggle, resizable } = useSidePanel(layoutRef, false);
	const labels = {
		name: t('@theorem.panel.trace.name'),
		show: t('@theorem.panel.trace.show'),
		hide: t('@theorem.panel.trace.hide'),
		resize: t('@theorem.panel.trace.resize'),
	};
	if (iface.observability?.record !== true) return { toggle: null, panel: null };
	return {
		toggle: <SidePanelToggle labels={labels} icon={<Icon icon={IconTimeline} />} panelId={id} open={open} onToggle={toggle} />,
		panel: (
			<SidePanel id={id} labels={labels} resizable={resizable} open={open} padding={0}>
				<TraceInspectorBody traces={traces} isWide={isSidePanelWide(resizable.size)} />
			</SidePanel>
		),
	};
}
