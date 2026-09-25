import { Button } from '@astryxdesign/core/Button';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { HStack } from '@astryxdesign/core/HStack';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { TRACE_FIELDS, traceAttributeMeta, traceEventMeta } from '../../../mod.ts';
import { nanosToMs, type TraceNode } from '../client/trace-view.ts';
import { attributeSections, SpanShareBar, SpanStatusDot, SpanTitle, TraceAttributeList, useTraceFormat } from './TraceValues';

/** Rows a root shows before "Show more". */
const ROOT_ROWS = 4;

function spanName(node: TraceNode): string {
	return node.meta.subject ? `${node.meta.label} ${node.meta.subject}` : node.meta.label;
}

/** Spans as rows, each nested under its parent, with its share of `ofMs`; a row opens its span. */
export function SpanRows({
	nodes,
	ofMs,
	onOpen,
}: {
	nodes: readonly TraceNode[];
	ofMs: number;
	onOpen: (node: TraceNode) => void;
}) {
	return (
		<VStack gap={1}>
			{nodes.map((node) => (
				<VStack key={node.id} gap={1}>
					<HStack gap={2} align="center">
						<SpanStatusDot status={node.span.status} />
						<Button label={spanName(node)} variant="ghost" size="sm" onClick={() => onOpen(node)} />
					</HStack>
					<SpanShareBar node={node} ofMs={ofMs} />
					{node.children.length > 0 ? (
						<VStack paddingInlineStart={3}>
							<SpanRows nodes={node.children} ofMs={ofMs} onOpen={onOpen} />
						</VStack>
					) : null}
				</VStack>
			))}
		</VStack>
	);
}

/** A Live session's events as rows: what happened, and when after the session started. */
function EventRows({ node }: { node: TraceNode }) {
	const format = useTraceFormat();
	if (node.span.events.length === 0) return null;
	return (
		<MetadataList columns="single" label={{ position: 'start' }} maxNumOfItems={ROOT_ROWS} title={TRACE_FIELDS.events.label}>
			{node.span.events.map((event, index) => (
				<MetadataListItem key={`${event.name}:${event.timeUnixNano}:${index}`} label={traceEventMeta(event.name)?.label ?? event.name}>
					<Text type="supporting" hasTabularNumbers>
						{format.t('@theorem.panel.trace.offset', { duration: format.duration(nanosToMs(event.timeUnixNano) - node.startMs) })}
					</Text>
				</MetadataListItem>
			))}
		</MetadataList>
	);
}

function RootItem({ node, onOpen }: { node: TraceNode; onOpen: (node: TraceNode) => void }) {
	const format = useTraceFormat();
	return (
		<Collapsible
			defaultIsOpen={false}
			trigger={
				<HStack gap={2} align="center" justify="between" width="100%">
					<HStack gap={2} align="center">
						<SpanStatusDot status={node.span.status} />
						<SpanTitle node={node} />
					</HStack>
					<Text type="supporting" hasTabularNumbers>
						{format.duration(node.durationMs)}
					</Text>
				</HStack>
			}
		>
			<VStack gap={3}>
				<TraceAttributeList
					record={node.record}
					attributes={Object.fromEntries(attributeSections(node.span.attributes).flatMap((section) => Object.entries(section.attributes)))}
					metaOf={traceAttributeMeta}
					maxNumOfItems={ROOT_ROWS}
				/>
				<EventRows node={node} />
				<VStack gap={1}>
					<Text weight="medium">{TRACE_FIELDS.children.label}</Text>
					<SpanRows nodes={[node]} ofMs={node.durationMs} onOpen={onOpen} />
				</VStack>
			</VStack>
		</Collapsible>
	);
}

/** The slim trace: each root collapsed to one line, expanding to its attributes, events and spans. */
export function TraceSpanList({ nodes, onOpen }: { nodes: readonly TraceNode[]; onOpen: (node: TraceNode) => void }) {
	return (
		<VStack gap={2}>
			{nodes.map((node) => (
				<RootItem key={node.id} node={node} onOpen={onOpen} />
			))}
		</VStack>
	);
}
