import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Grid } from '@astryxdesign/core/Grid';
import { HStack } from '@astryxdesign/core/HStack';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { proportional, Table, type TableColumn, useTableTreeData, useTableTreeState } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { ReactNode } from 'react';
import { TRACE_FIELDS, TRACE_STATUS, traceAttributeMeta } from '../../../mod.ts';
import type { TraceNode, TraceTotals } from '../client/trace-view.ts';
import { SpanShareBar, SpanStatusDot, SpanTitle, useTraceFormat } from './TraceValues';

/** A table row: a span, the duration its bar is a share of (its root's), and its child rows. */
type TraceRow = { id: string; node: TraceNode; ofMs: number; children: TraceRow[] };

function traceRows(nodes: readonly TraceNode[], ofMs?: number): TraceRow[] {
	return nodes.map((node) => {
		const rootMs = ofMs ?? node.durationMs;
		return { id: node.id, node, ofMs: rootMs, children: traceRows(node.children, rootMs) };
	});
}

function SummaryCard({ label, children }: { label: string; children: ReactNode }) {
	return (
		<Card padding={3}>
			<VStack gap={1}>
				<Text type="supporting">{label}</Text>
				{children}
			</VStack>
		</Card>
	);
}

/** Duration, tokens, cost and errors across the shown spans; a total no call reported is left out. */
function TraceSummary({ totals }: { totals: TraceTotals }) {
	const format = useTraceFormat();
	const tokens = [
		['gen_ai.usage.input_tokens', totals.input],
		['gen_ai.usage.cache_read.input_tokens', totals.cached],
		['gen_ai.usage.output_tokens', totals.output],
	] as const;
	return (
		<Grid columns={4} gap={2}>
			<SummaryCard label={TRACE_FIELDS.duration.label}>
				<Text type="large" hasTabularNumbers>
					{format.duration(totals.durationMs)}
				</Text>
			</SummaryCard>
			{totals.input || totals.output ? (
				<SummaryCard label={format.t('@theorem.panel.trace.tokens')}>
					<MetadataList columns="single" label={{ position: 'start' }}>
						{tokens.flatMap(([key, sum]) =>
							sum
								? [
										<MetadataListItem key={key} label={traceAttributeMeta(key)?.label ?? key}>
											<Text hasTabularNumbers>{format.sum(sum, format.number)}</Text>
										</MetadataListItem>,
									]
								: [],
						)}
					</MetadataList>
				</SummaryCard>
			) : null}
			{totals.cost ? (
				<SummaryCard label={traceAttributeMeta('theorem.usage.cost_usd')?.label ?? 'theorem.usage.cost_usd'}>
					<Text type="large" hasTabularNumbers>
						{format.sum(totals.cost, format.usd)}
					</Text>
				</SummaryCard>
			) : null}
			<SummaryCard label={format.t('@theorem.panel.trace.errors')}>
				<Text type="large" hasTabularNumbers>
					{format.number(totals.errors)}
				</Text>
			</SummaryCard>
		</Grid>
	);
}

/** The wide trace: totals as cards over a tree table of every span; a row opens its span. */
export function TraceSpanTable({
	nodes,
	totals,
	onOpen,
}: {
	nodes: readonly TraceNode[];
	totals: TraceTotals;
	onOpen: (node: TraceNode) => void;
}) {
	const format = useTraceFormat();
	const rows = traceRows(nodes);
	const { visibleData, treeConfig } = useTableTreeState({
		data: rows,
		idKey: 'id',
		childrenKey: 'children',
		defaultExpandedIds: rows.map((row) => row.id),
	});
	const tree = useTableTreeData(treeConfig);
	const columns: TableColumn<TraceRow>[] = [
		{
			key: 'span',
			header: TRACE_FIELDS.span.label,
			width: proportional(2),
			renderCell: (row) => (
				<Button label={row.node.meta.label} variant="ghost" size="sm" onClick={() => onOpen(row.node)}>
					<SpanTitle node={row.node} />
				</Button>
			),
		},
		{
			key: 'status',
			header: TRACE_FIELDS.status.label,
			width: proportional(1),
			renderCell: (row) => (
				<HStack gap={1} align="center">
					<SpanStatusDot status={row.node.span.status} />
					<Text>{TRACE_STATUS[row.node.span.status.code].label}</Text>
				</HStack>
			),
		},
		{
			key: 'duration',
			header: TRACE_FIELDS.duration.label,
			width: proportional(2),
			renderCell: (row) => <SpanShareBar node={row.node} ofMs={row.ofMs} />,
		},
	];
	return (
		<VStack gap={3}>
			<TraceSummary totals={totals} />
			<Table
				data={visibleData}
				columns={columns}
				idKey="id"
				plugins={{ tree }}
				density="compact"
				hasHover
				textOverflow="truncate"
				aria-label={format.t('@theorem.panel.trace.name')}
			/>
		</VStack>
	);
}
