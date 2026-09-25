import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { IconArrowLeft } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import {
	TRACE_ATTRIBUTE_GROUPS,
	TRACE_FIELDS,
	TRACE_SPAN_TYPES,
	TRACE_STATUS,
	type TraceAttributeMeta,
	type TraceOptionMeta,
	traceAttributeMeta,
	traceEventAttributeMeta,
	traceEventMeta,
} from '../../../mod.ts';
import { nanosToMs, type TraceNode } from '../client/trace-view.ts';
import { SpanRows } from './TraceSpanList';
import { attributeSections, SpanStatusDot, SpanTitle, TraceAttributeList, TraceValue, useTraceFormat } from './TraceValues';

/** A span's own field, read as an attribute of that format. */
function fieldMeta(field: TraceOptionMeta, format: TraceAttributeMeta['format']): TraceAttributeMeta {
	return { ...field, format, group: 'record' };
}

const SPAN_FIELD_META = {
	type: { ...fieldMeta(TRACE_FIELDS.type, 'text'), options: TRACE_SPAN_TYPES },
	status: { ...fieldMeta(TRACE_FIELDS.status, 'text'), options: TRACE_STATUS },
	start: fieldMeta(TRACE_FIELDS.start, 'time'),
	traceId: fieldMeta(TRACE_FIELDS.traceId, 'id'),
	spanId: fieldMeta(TRACE_FIELDS.spanId, 'id'),
} satisfies Record<string, TraceAttributeMeta>;

function spanFieldMeta(key: string): TraceAttributeMeta | undefined {
	return key in SPAN_FIELD_META ? SPAN_FIELD_META[key as keyof typeof SPAN_FIELD_META] : undefined;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<Collapsible defaultIsOpen={false} trigger={<Text weight="medium">{title}</Text>}>
			{children}
		</Collapsible>
	);
}

function numberAttribute(node: TraceNode, key: string): number | undefined {
	const value = node.span.attributes[key];
	return typeof value === 'number' ? value : undefined;
}

/** Input, cached, thinking and output tokens as bars: cached of input, thinking of output, each side of the whole. */
function TokensCard({ node }: { node: TraceNode }) {
	const format = useTraceFormat();
	const input = numberAttribute(node, 'gen_ai.usage.input_tokens');
	const output = numberAttribute(node, 'gen_ai.usage.output_tokens');
	if (input === undefined && output === undefined) return null;
	const total = (input ?? 0) + (output ?? 0);
	const bars: { key: string; of: number }[] = [
		{ key: 'gen_ai.usage.input_tokens', of: total },
		{ key: 'gen_ai.usage.cache_read.input_tokens', of: input ?? 0 },
		{ key: 'gen_ai.usage.output_tokens', of: total },
		{ key: 'gen_ai.usage.reasoning.output_tokens', of: output ?? 0 },
	];
	return (
		<Card padding={3} variant="muted">
			<VStack gap={2}>
				<Text weight="medium">{format.t('@theorem.panel.trace.tokens')}</Text>
				{bars.flatMap(({ key, of }) => {
					const value = numberAttribute(node, key);
					const label = traceAttributeMeta(key)?.label ?? key;
					if (value === undefined) return [];
					return [
						<VStack key={key} gap={1}>
							<Text type="supporting">{label}</Text>
							<ProgressBar
								label={label}
								isLabelHidden
								hasValueLabel
								value={value}
								max={Math.max(of, value)}
								formatValueLabel={(count) => format.number(count)}
							/>
						</VStack>,
					];
				})}
			</VStack>
		</Card>
	);
}

function EventList({ node }: { node: TraceNode }) {
	const format = useTraceFormat();
	return (
		<VStack gap={3}>
			{node.span.events.map((event, index) => {
				const offset = format.t('@theorem.panel.trace.offset', {
					duration: format.duration(nanosToMs(event.timeUnixNano) - node.startMs),
				});
				const label = traceEventMeta(event.name)?.label ?? event.name;
				return (
					<VStack key={`${event.name}:${event.timeUnixNano}:${index}`} gap={1}>
						<HStack gap={2} align="center">
							<Text weight="medium">{label}</Text>
							<Text type="supporting" hasTabularNumbers>
								{offset}
							</Text>
						</HStack>
						<TraceAttributeList
							record={node.record}
							attributes={event.attributes}
							metaOf={(key) => traceEventAttributeMeta(event.name, key)}
						/>
					</VStack>
				);
			})}
		</VStack>
	);
}

function LinkList({ node }: { node: TraceNode }) {
	return (
		<VStack gap={3}>
			{node.span.links.map((link) => (
				<TraceAttributeList
					key={`${link.traceId}:${link.spanId}`}
					record={node.record}
					attributes={{ traceId: link.traceId, spanId: link.spanId, ...link.attributes }}
					metaOf={(key) => spanFieldMeta(key) ?? traceAttributeMeta(key)}
				/>
			))}
		</VStack>
	);
}

const SPAN_FIELD_VALUES = {
	type: (node) => node.meta.type,
	start: (node) => node.span.startTimeUnixNano,
	traceId: (node) => node.span.traceId,
	spanId: (node) => node.span.spanId,
} satisfies Partial<Record<keyof typeof SPAN_FIELD_META, (node: TraceNode) => string>>;

/** Back to every span, then what this one is, how it ended and how long it took. */
function SpanHeader({ node, onBack }: { node: TraceNode; onBack: () => void }) {
	const format = useTraceFormat();
	const { status } = node.span;
	return (
		<>
			<HStack>
				<Button
					label={format.t('@theorem.panel.trace.back')}
					variant="ghost"
					size="sm"
					icon={<Icon icon={IconArrowLeft} />}
					onClick={onBack}
				/>
			</HStack>
			<VStack gap={1}>
				<SpanTitle node={node} />
				<HStack gap={2} align="center">
					<SpanStatusDot status={status} />
					<Text type="supporting">{TRACE_STATUS[status.code].label}</Text>
					<Text type="supporting" hasTabularNumbers>
						{format.duration(node.durationMs)}
					</Text>
				</HStack>
				{status.message ? <Text color="secondary">{status.message}</Text> : null}
			</VStack>
		</>
	);
}

/** The span's own fields: its type, start and IDs. */
function SpanFields({ node }: { node: TraceNode }) {
	return (
		<MetadataList columns="single" label={{ position: 'start' }}>
			{(Object.keys(SPAN_FIELD_VALUES) as (keyof typeof SPAN_FIELD_VALUES)[]).map((key) => (
				<MetadataListItem key={key} label={SPAN_FIELD_META[key].label}>
					<TraceValue record={node.record} meta={SPAN_FIELD_META[key]} value={SPAN_FIELD_VALUES[key](node)} />
				</MetadataListItem>
			))}
		</MetadataList>
	);
}

/** The record's host resource and request metadata, shown on the span that roots the record. */
function RecordSections({ node }: { node: TraceNode }) {
	const { record } = node;
	if (record.spans[0]?.spanId !== node.span.spanId) return null;
	return (
		<>
			{Object.keys(record.resource).length > 0 ? (
				<Section title={TRACE_FIELDS.resource.label}>
					<TraceAttributeList record={record} attributes={record.resource} metaOf={traceAttributeMeta} />
				</Section>
			) : null}
			{record.metadata ? (
				<Section title={TRACE_FIELDS.metadata.label}>
					<TraceAttributeList record={record} attributes={record.metadata} metaOf={() => undefined} />
				</Section>
			) : null}
		</>
	);
}

/** One span in full: what it is, how it ended, its tokens, and every attribute, span, event and link it recorded. */
export function TraceSpanDetail({
	node,
	onBack,
	onOpen,
}: {
	node: TraceNode;
	onBack: () => void;
	onOpen: (node: TraceNode) => void;
}) {
	const { t } = useTraceFormat();
	const { span, record } = node;
	return (
		<VStack gap={3}>
			<SpanHeader node={node} onBack={onBack} />
			<TokensCard node={node} />
			<SpanFields node={node} />
			{attributeSections(span.attributes).map((section) => (
				<Section
					key={section.key}
					title={section.key === 'other' ? t('@theorem.panel.trace.other') : TRACE_ATTRIBUTE_GROUPS[section.key].label}
				>
					<TraceAttributeList record={record} attributes={section.attributes} metaOf={traceAttributeMeta} />
				</Section>
			))}
			{node.children.length > 0 ? (
				<Section title={TRACE_FIELDS.children.label}>
					<SpanRows nodes={node.children} ofMs={node.durationMs} onOpen={onOpen} />
				</Section>
			) : null}
			{span.events.length > 0 ? (
				<Section title={TRACE_FIELDS.events.label}>
					<EventList node={node} />
				</Section>
			) : null}
			{span.links.length > 0 ? (
				<Section title={TRACE_FIELDS.links.label}>
					<LinkList node={node} />
				</Section>
			) : null}
			<RecordSections node={node} />
		</VStack>
	);
}
