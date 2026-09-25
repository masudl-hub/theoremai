import { Button } from '@astryxdesign/core/Button';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { useLocale } from '@astryxdesign/core/i18n';
import { HStack } from '@astryxdesign/core/HStack';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { StatusDot, type StatusDotVariant } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { VStack } from '@astryxdesign/core/VStack';
import { useMemo, useState } from 'react';
import {
	inlineContent,
	TRACE_ATTRIBUTE_GROUPS,
	TRACE_STATUS,
	type TraceAttributeGroup,
	type TraceAttributeMeta,
	type TraceOptionMeta,
	type TraceRecord,
	type TraceSpanStatus,
	traceAttributeMeta,
} from '../../../mod.ts';
import { nanosToMs, type TraceNode, type TraceSum, type TraceTokenSum, traceValueShape } from '../client/trace-view.ts';
import { type LabelText, workDuration } from './labels';
import { useLabels } from './labels-provider';

export type AttributeSection = { key: TraceAttributeGroup | 'other'; attributes: Record<string, unknown> };

/** A span's attributes by catalog group, in the catalog's order; keys it does not name last. */
export function attributeSections(attributes: Readonly<Record<string, unknown>>): AttributeSection[] {
	const byGroup = new Map<TraceAttributeGroup | 'other', Record<string, unknown>>();
	for (const [key, value] of Object.entries(attributes)) {
		const group = traceAttributeMeta(key)?.group ?? 'other';
		byGroup.set(group, { ...byGroup.get(group), [key]: value });
	}
	const order: (TraceAttributeGroup | 'other')[] = [...(Object.keys(TRACE_ATTRIBUTE_GROUPS) as TraceAttributeGroup[]), 'other'];
	return order.flatMap((key) => {
		const grouped = byGroup.get(key);
		return grouped ? [{ key, attributes: grouped }] : [];
	});
}

/** Formats for trace values, in the viewer's locale. */
export interface TraceFormat {
	t: LabelText;
	number(value: number): string;
	usd(value: number): string;
	duration(ms: number): string;
	list(items: readonly string[]): string;
	/** A total, worded as partial or estimated when it is. */
	sum(sum: TraceSum | TraceTokenSum, format: (value: number) => string): string;
}

export function useTraceFormat(): TraceFormat {
	const t = useLabels();
	const locale = useLocale();
	return useMemo(() => {
		const number = new Intl.NumberFormat(locale);
		const usd = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 6 });
		const list = new Intl.ListFormat(locale, { type: 'conjunction' });
		return {
			t,
			number: (value) => number.format(value),
			usd: (value) => usd.format(value),
			duration: (ms) => workDuration(t, ms),
			list: (items) => list.format(items),
			sum(total, format) {
				const value = 'estimated' in total && total.estimated ? t('@theorem.panel.trace.about', { value: format(total.value) }) : format(total.value);
				return total.complete ? value : t('@theorem.panel.trace.at_least', { value });
			},
		};
	}, [t, locale]);
}

/** A value as it was stored, with its references rebuilt, shown on click. */
function StoredText({ record, value }: { record: TraceRecord; value: unknown }) {
	const { t } = useTraceFormat();
	const [isShown, setIsShown] = useState(false);
	const inlined = inlineContent(record, value);
	return (
		<VStack gap={1}>
			<Button
				label={t(isShown ? '@theorem.panel.trace.hide_text' : '@theorem.panel.trace.show_text')}
				variant="ghost"
				size="sm"
				aria-expanded={isShown}
				onClick={() => setIsShown((shown) => !shown)}
			/>
			{isShown ? (
				<CodeBlock
					code={typeof inlined === 'string' ? inlined : JSON.stringify(inlined, null, 2)}
					language={typeof inlined === 'string' ? 'text' : 'json'}
					isWrapped
					size="sm"
					hasCopyButton
				/>
			) : null}
		</VStack>
	);
}

/** An option's label, with its meaning on hover. */
function OptionValue({ option }: { option: TraceOptionMeta }) {
	return (
		<Tooltip content={option.doc}>
			<Text>{option.label}</Text>
		</Tooltip>
	);
}

function formatNumber(format: TraceFormat, meta: TraceAttributeMeta | undefined, value: number): string {
	switch (meta?.format) {
		case 'usd':
			return format.usd(value);
		case 'milliseconds':
			return format.duration(value);
		case 'seconds':
			return format.duration(value * 1_000);
		default:
			return format.number(value);
	}
}

function StringValue({ meta, value }: { meta: TraceAttributeMeta | undefined; value: string }) {
	const option = meta?.options?.[value];
	if (option) return <OptionValue option={option} />;
	if (meta?.format === 'time') return <Timestamp value={nanosToMs(value)} format="system_date_time" />;
	return <Text type={meta?.format === 'id' ? 'code' : 'body'}>{value}</Text>;
}

function ScalarValue({ meta, value }: { meta: TraceAttributeMeta | undefined; value: number | boolean }) {
	const format = useTraceFormat();
	if (typeof value === 'boolean') return <Text>{format.t(value ? '@theorem.panel.trace.yes' : '@theorem.panel.trace.no')}</Text>;
	return <Text hasTabularNumbers>{formatNumber(format, meta, value)}</Text>;
}

function ListValue({ meta, value }: { meta: TraceAttributeMeta | undefined; value: readonly string[] }) {
	const format = useTraceFormat();
	return <Text>{format.list(value.map((item) => meta?.options?.[item]?.label ?? item))}</Text>;
}

/** One attribute value, read by its catalog entry; a key the catalog does not name reads by its shape. */
export function TraceValue({
	record,
	meta,
	value,
}: {
	record: TraceRecord;
	meta: TraceAttributeMeta | undefined;
	value: unknown;
}) {
	const shape = traceValueShape(meta, value);
	switch (shape.kind) {
		case 'text':
			return <StringValue meta={meta} value={shape.value} />;
		case 'scalar':
			return <ScalarValue meta={meta} value={shape.value} />;
		case 'list':
			return <ListValue meta={meta} value={shape.value} />;
		case 'fields':
			return (
				<VStack gap={2}>
					{shape.items.map((item, index) => (
						<TraceAttributeList key={index} record={record} attributes={item} metaOf={(key) => shape.fields[key]} />
					))}
				</VStack>
			);
		case 'stored':
			return <StoredText record={record} value={value} />;
	}
}

/** Attributes as label and value rows, worded by `metaOf`; a key it does not name shows as recorded. */
export function TraceAttributeList({
	record,
	attributes,
	metaOf,
	maxNumOfItems,
	title,
}: {
	record: TraceRecord;
	attributes: Readonly<Record<string, unknown>>;
	metaOf: (key: string) => TraceAttributeMeta | undefined;
	maxNumOfItems?: number;
	title?: string;
}) {
	const entries = Object.entries(attributes);
	if (entries.length === 0) return null;
	return (
		<MetadataList columns="single" label={{ position: 'start' }} maxNumOfItems={maxNumOfItems} title={title}>
			{entries.map(([key, value]) => (
				<MetadataListItem key={key} label={metaOf(key)?.label ?? key}>
					<TraceValue record={record} meta={metaOf(key)} value={value} />
				</MetadataListItem>
			))}
		</MetadataList>
	);
}

const STATUS_DOTS: Readonly<Record<TraceSpanStatus['code'], StatusDotVariant>> = {
	OK: 'success',
	ERROR: 'error',
	UNSET: 'neutral',
};

/** How a span ended, as a dot; its meaning and message on hover. */
export function SpanStatusDot({ status }: { status: TraceSpanStatus }) {
	const meta = TRACE_STATUS[status.code];
	return <StatusDot variant={STATUS_DOTS[status.code]} label={meta.label} tooltip={status.message ?? meta.doc} />;
}

/** What a span is and what it acted on: "Model call gemini-3-flash". */
export function SpanTitle({ node }: { node: TraceNode }) {
	return (
		<HStack gap={1} align="center">
			<Tooltip content={node.meta.doc}>
				<Text weight="medium">{node.meta.label}</Text>
			</Tooltip>
			{node.meta.subject ? (
				<Text type="code" color="secondary" maxLines={1}>
					{node.meta.subject}
				</Text>
			) : null}
		</HStack>
	);
}

/** A span's duration as its share of `ofMs` (its trace's), labeled with the duration. */
export function SpanShareBar({ node, ofMs }: { node: TraceNode; ofMs: number }) {
	const format = useTraceFormat();
	return (
		<ProgressBar
			label={node.meta.label}
			isLabelHidden
			hasValueLabel
			value={node.durationMs}
			max={Math.max(ofMs, node.durationMs)}
			formatValueLabel={(value) => format.duration(value)}
			variant={node.span.status.code === 'ERROR' ? 'error' : 'accent'}
		/>
	);
}
