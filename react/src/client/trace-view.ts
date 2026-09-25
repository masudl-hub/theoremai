import {
	inlineContent,
	TRACE_ATTRIBUTE_GROUPS,
	TRACE_FIELDS,
	TRACE_SPAN_TYPES,
	TRACE_STATUS,
	type TraceAttributeMeta,
	type TraceAttributeValue,
	type TraceOptionMeta,
	type TraceRecord,
	type TraceSpan,
	type TraceSpanMeta,
	type TraceSpanType,
	traceAttributeMeta,
	traceEventMeta,
	traceSpanMeta,
} from '../../../mod.ts';
import { isRecord } from '../../../src/kernel/util/record.ts';

/**
 * The trace panel's reading of the records a run delivered: one span tree,
 * totals over it, and search over its spans. Every word comes from the trace
 * catalog; the panel only lays it out.
 *
 * @module
 */

/** One span, placed: the record that carries it, what it is, its timing, and the spans inside it. */
export interface TraceNode {
	/** `traceId:spanId`, unique across records. */
	id: string;
	span: TraceSpan;
	record: TraceRecord;
	meta: TraceSpanMeta;
	/** Unix milliseconds. */
	startMs: number;
	durationMs: number;
	/** In start order. */
	children: TraceNode[];
}

/** A unix-nanosecond timestamp string as unix milliseconds. */
export function nanosToMs(nanos: string): number {
	return Number(BigInt(nanos) / 1_000n) / 1_000;
}

function spanId(traceId: string, id: string): string {
	return `${traceId}:${id}`;
}

function byStart(a: TraceNode, b: TraceNode): number {
	return a.startMs - b.startMs;
}

/**
 * Every span of `records` as one tree. A span written twice keeps its later
 * copy; a span whose parent has not arrived yet (a Live response before its
 * session root) is a root until the parent does.
 */
export function traceTree(records: readonly TraceRecord[]): TraceNode[] {
	const nodes = new Map<string, TraceNode>();
	for (const record of records) {
		for (const span of record.spans) {
			const startMs = nanosToMs(span.startTimeUnixNano);
			nodes.set(spanId(span.traceId, span.spanId), {
				id: spanId(span.traceId, span.spanId),
				span,
				record,
				meta: traceSpanMeta(span),
				startMs,
				durationMs: nanosToMs(span.endTimeUnixNano) - startMs,
				children: [],
			});
		}
	}
	const roots: TraceNode[] = [];
	for (const node of nodes.values()) {
		const parent = node.span.parentSpanId ? nodes.get(spanId(node.span.traceId, node.span.parentSpanId)) : undefined;
		(parent ? parent.children : roots).push(node);
	}
	for (const node of nodes.values()) node.children.sort(byStart);
	return roots.sort(byStart);
}

/** Every node of `nodes`, depth first. */
export function traceSpans(nodes: readonly TraceNode[]): TraceNode[] {
	return nodes.flatMap((node) => [node, ...traceSpans(node.children)]);
}

// ── totals ──────────────────────────────────────────

/** A sum over the model calls; `complete` is false when some call did not report it. */
export interface TraceSum {
	value: number;
	complete: boolean;
}

/** A token sum; `estimated` when THEOREM estimated some call's count rather than the provider reporting it. */
export interface TraceTokenSum extends TraceSum {
	estimated: boolean;
}

/**
 * Totals over a set of spans. Usage and cost sum the model calls (and Live
 * responses) themselves, not the roots, so a specialist's or a compaction's
 * calls count once. A total no call reported is absent: unknown, not zero.
 */
export interface TraceTotals {
	spans: number;
	errors: number;
	/** First start to last end. */
	durationMs: number;
	/** Model calls and Live responses. */
	calls: number;
	input?: TraceTokenSum;
	cached?: TraceSum;
	output?: TraceTokenSum;
	cost?: TraceSum;
}

const MODEL_CALL_TYPES: ReadonlySet<TraceSpanType> = new Set(['call', 'response']);

function numberAttribute(span: TraceSpan, key: string): number | undefined {
	const value = span.attributes[key];
	return typeof value === 'number' ? value : undefined;
}

function isEstimated(span: TraceSpan, side: 'input' | 'output'): boolean {
	const estimated = span.attributes['theorem.usage.estimated'];
	return Array.isArray(estimated) && estimated.includes(side);
}

function sum(calls: readonly TraceSpan[], key: string, partial?: (span: TraceSpan) => boolean): TraceSum | undefined {
	const values = calls.map((span) => numberAttribute(span, key));
	const reported = values.filter((value) => value !== undefined);
	if (reported.length === 0) return undefined;
	return {
		value: reported.reduce((total, value) => total + value, 0),
		complete: reported.length === calls.length && !calls.some((span) => partial?.(span) === true),
	};
}

function tokenSum(calls: readonly TraceSpan[], key: string, side: 'input' | 'output'): TraceTokenSum | undefined {
	const total = sum(calls, key);
	return total && { ...total, estimated: calls.some((span) => isEstimated(span, side)) };
}

export function traceTotals(nodes: readonly TraceNode[]): TraceTotals {
	const spans = traceSpans(nodes);
	const calls = spans.filter((node) => MODEL_CALL_TYPES.has(node.meta.type)).map((node) => node.span);
	const start = Math.min(...spans.map((node) => node.startMs));
	const end = Math.max(...spans.map((node) => node.startMs + node.durationMs));
	const input = tokenSum(calls, 'gen_ai.usage.input_tokens', 'input');
	const cached = sum(calls, 'gen_ai.usage.cache_read.input_tokens');
	const output = tokenSum(calls, 'gen_ai.usage.output_tokens', 'output');
	const cost = sum(calls, 'theorem.usage.cost_usd', (span) => span.attributes['theorem.usage.cost_partial'] === true);
	return {
		spans: spans.length,
		errors: spans.filter((node) => node.span.status.code === 'ERROR').length,
		durationMs: spans.length === 0 ? 0 : end - start,
		calls: calls.length,
		...(input && { input }),
		...(cached && { cached }),
		...(output && { output }),
		...(cost && { cost }),
	};
}

// ── search ──────────────────────────────────────────

/** How a search field compares: one of a set, a number, text, or yes/no. */
export type TraceSearchKind = 'options' | 'number' | 'text' | 'flag';

/** The operators each kind offers, by PowerSearch operator key. */
export const TRACE_SEARCH_OPERATORS = {
	options: ['isAnyOf', 'isNoneOf'],
	number: ['greaterThan', 'lessThan'],
	text: ['contains', 'notContains'],
	flag: ['isTrue', 'isFalse'],
} as const satisfies Record<TraceSearchKind, readonly string[]>;

/** One searchable field of a span, worded by the catalog. */
export interface TraceSearchField {
	key: string;
	label: string;
	doc: string;
	kind: TraceSearchKind;
	/** The attribute group's label; absent for a span's own fields and for keys the catalog does not name. */
	group?: string;
	/** For `options`: each value seen, with its meaning when the catalog knows it. */
	options?: readonly TraceSearchOption[];
	/** For a number field: its unit, when it has one. */
	format?: TraceAttributeMeta['format'];
}

export interface TraceSearchOption {
	value: string;
	label: string;
	doc?: string;
}

/** The field that searches any text a span holds: its name, its values, its stored text. */
export const TRACE_TEXT_FIELD = 'text';

/** Span fields beside the attributes. */
const TYPE_FIELD = 'type';
const STATUS_FIELD = 'status';
const DURATION_FIELD = 'duration';
const EVENTS_FIELD = 'events';

/** A filter as PowerSearch emits it. */
export interface TraceFilter {
	readonly field: string;
	readonly operator: string;
	readonly value: { readonly type: string; readonly value?: unknown };
}

const NUMBER_FORMATS: ReadonlySet<TraceAttributeMeta['format']> = new Set(['number', 'tokens', 'seconds', 'milliseconds', 'usd']);
const TEXT_FORMATS: ReadonlySet<TraceAttributeMeta['format']> = new Set(['text', 'id', 'list']);

function optionsOf(seen: ReadonlySet<string>, known: Readonly<Record<string, TraceOptionMeta>>): TraceSearchOption[] {
	return [...seen].sort().map((value) => {
		const meta = known[value];
		return meta ? { value, label: meta.label, doc: meta.doc } : { value, label: value };
	});
}

function attributeValues(value: TraceAttributeValue): TraceAttributeValue[] {
	return Array.isArray(value) ? value : [value];
}

function attributeKind(meta: TraceAttributeMeta | undefined, value: TraceAttributeValue): TraceSearchKind | undefined {
	if (meta?.options) return 'options';
	const format = meta?.format;
	if (format === 'boolean' || (!meta && typeof value === 'boolean')) return 'flag';
	if ((format && NUMBER_FORMATS.has(format)) || (!meta && typeof value === 'number')) return 'number';
	if ((format && TEXT_FORMATS.has(format)) || (!meta && typeof value === 'string')) return 'text';
	return undefined;
}

/**
 * The fields a search over `nodes` offers: type, status, duration and events,
 * then every attribute the spans recorded that compares as a value. Stored
 * text, JSON and structured values are reached by the text field.
 */
export function traceSearchFields(nodes: readonly TraceNode[]): TraceSearchField[] {
	const spans = traceSpans(nodes);
	const types = new Set(spans.map((node) => node.meta.type));
	const statuses = new Set(spans.map((node) => node.span.status.code));
	const events = new Set(spans.flatMap((node) => node.span.events.map((event) => event.name)));
	const attributes = new Map<string, { kind: TraceSearchKind; seen: Set<string> }>();
	for (const node of spans) {
		for (const [key, value] of Object.entries(node.span.attributes)) {
			const kind = attributeKind(traceAttributeMeta(key), value);
			if (!kind) continue;
			const field = attributes.get(key) ?? { kind, seen: new Set<string>() };
			if (kind === 'options') for (const item of attributeValues(value)) if (typeof item === 'string') field.seen.add(item);
			attributes.set(key, field);
		}
	}
	const eventLabels = Object.fromEntries([...events].flatMap((name) => {
		const meta = traceEventMeta(name);
		return meta ? [[name, meta]] : [];
	}));
	const fields: TraceSearchField[] = [
		{ key: TYPE_FIELD, ...TRACE_FIELDS.type, kind: 'options', options: optionsOf(types, TRACE_SPAN_TYPES) },
		{ key: STATUS_FIELD, ...TRACE_FIELDS.status, kind: 'options', options: optionsOf(statuses, TRACE_STATUS) },
		{ key: DURATION_FIELD, ...TRACE_FIELDS.duration, kind: 'number', format: 'milliseconds' },
	];
	if (events.size > 0) fields.push({ key: EVENTS_FIELD, ...TRACE_FIELDS.events, kind: 'options', options: optionsOf(events, eventLabels) });
	for (const [key, { kind, seen }] of [...attributes].sort(([a], [b]) => a.localeCompare(b))) {
		const meta = traceAttributeMeta(key);
		fields.push({
			key,
			label: meta?.label ?? key,
			doc: meta?.doc ?? key,
			kind,
			...(meta && { group: TRACE_ATTRIBUTE_GROUPS[meta.group].label, format: meta.format }),
			...(kind === 'options' && { options: optionsOf(seen, meta?.options ?? {}) }),
		});
	}
	return fields;
}

/** Every string a span holds: what it is, its name and status, and its attributes and events with stored text inlined. */
function spanText(node: TraceNode): string {
	const strings: string[] = [node.meta.label, node.meta.subject ?? '', node.span.name, node.span.status.message ?? ''];
	const collect = (value: unknown): void => {
		if (typeof value === 'string') strings.push(value);
		else if (Array.isArray(value)) for (const item of value) collect(item);
		else if (value && typeof value === 'object') for (const nested of Object.values(value)) collect(nested);
	};
	collect(inlineContent(node.record, { attributes: node.span.attributes, events: node.span.events }));
	for (const event of node.span.events) strings.push(traceEventMeta(event.name)?.label ?? '');
	return strings.join('\n').toLocaleLowerCase();
}

/** A field's values on one span: strings for options and text, a number, or a yes/no. */
function fieldValues(node: TraceNode, field: string): readonly (string | number | boolean)[] {
	switch (field) {
		case TYPE_FIELD:
			return [node.meta.type];
		case STATUS_FIELD:
			return [node.span.status.code];
		case DURATION_FIELD:
			return [node.durationMs];
		case EVENTS_FIELD:
			return node.span.events.map((event) => event.name);
		default: {
			const value = node.span.attributes[field];
			if (value === undefined) return [];
			return attributeValues(value).filter((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean');
		}
	}
}

function stringList(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function matchesFilter(node: TraceNode, filter: TraceFilter): boolean {
	const { value } = filter.value;
	if (filter.field === TRACE_TEXT_FIELD) {
		const found = typeof value === 'string' && spanText(node).includes(value.toLocaleLowerCase());
		return filter.operator === 'notContains' ? !found : found;
	}
	const values = fieldValues(node, filter.field);
	switch (filter.operator) {
		case 'isAnyOf':
			return values.some((item) => typeof item === 'string' && stringList(value).includes(item));
		case 'isNoneOf':
			return !values.some((item) => typeof item === 'string' && stringList(value).includes(item));
		case 'greaterThan':
			return typeof value === 'number' && values.some((item) => typeof item === 'number' && item > value);
		case 'lessThan':
			return typeof value === 'number' && values.some((item) => typeof item === 'number' && item < value);
		case 'contains':
		case 'notContains': {
			const found =
				typeof value === 'string' && values.some((item) => String(item).toLocaleLowerCase().includes(value.toLocaleLowerCase()));
			return filter.operator === 'contains' ? found : !found;
		}
		case 'isTrue':
			return values.includes(true);
		case 'isFalse':
			return values.includes(false);
		default:
			return false;
	}
}

/** Whether a span meets every filter. */
function traceMatches(node: TraceNode, filters: readonly TraceFilter[]): boolean {
	return filters.every((filter) => matchesFilter(node, filter));
}

/**
 * The tree cut to the spans that meet every filter, each kept under its
 * ancestors so it reads in place; `matches` counts the spans that met them.
 */
export function filterTraceTree(nodes: readonly TraceNode[], filters: readonly TraceFilter[]): { nodes: TraceNode[]; matches: number } {
	if (filters.length === 0) return { nodes: [...nodes], matches: traceSpans(nodes).length };
	let matches = 0;
	const keep = (node: TraceNode): TraceNode | undefined => {
		const hit = traceMatches(node, filters);
		if (hit) matches += 1;
		const children = node.children.flatMap((child) => keep(child) ?? []);
		return hit || children.length > 0 ? { ...node, children } : undefined;
	};
	return { nodes: nodes.flatMap((node) => keep(node) ?? []), matches };
}

/** Formats whose value is stored text or structure: shown on click, never inline. */
const STORED_FORMATS: ReadonlySet<TraceAttributeMeta['format']> = new Set(['content', 'json', 'messages', 'parts']);


function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** An object, or a list of objects, as items to read by a catalog entry's fields. */
function fieldItems(value: unknown): Record<string, unknown>[] | undefined {
	if (isRecord(value)) return [value];
	return Array.isArray(value) && value.every(isRecord) ? value : undefined;
}

/** How to show an attribute value: by its catalog entry first, then by its shape. */
export type TraceValueShape =
	| { kind: 'stored' }
	| { kind: 'text'; value: string }
	| { kind: 'scalar'; value: number | boolean }
	| { kind: 'list'; value: string[] }
	| { kind: 'fields'; fields: Readonly<Record<string, TraceAttributeMeta>>; items: Record<string, unknown>[] };

export function traceValueShape(meta: TraceAttributeMeta | undefined, value: unknown): TraceValueShape {
	if (meta && STORED_FORMATS.has(meta.format)) return { kind: 'stored' };
	if (typeof value === 'string') return { kind: 'text', value };
	if (typeof value === 'number' || typeof value === 'boolean') return { kind: 'scalar', value };
	if (isStringList(value)) return { kind: 'list', value };
	const items = meta?.fields ? fieldItems(value) : undefined;
	return meta?.fields && items ? { kind: 'fields', fields: meta.fields, items } : { kind: 'stored' };
}
