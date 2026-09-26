import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Collapsible, CollapsibleGroup } from '@astryxdesign/core/Collapsible';
import { HStack } from '@astryxdesign/core/HStack';
import { useLocale } from '@astryxdesign/core/i18n';
import { Link } from '@astryxdesign/core/Link';
import { List, ListItem } from '@astryxdesign/core/List';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Table, type TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { Component, type ReactNode, useMemo, useState } from 'react';
import { useLabels } from './labels-provider';

/**
 * Tool call data and structured replies drawn by their shape instead of as
 * JSON. JSON has six kinds of value, so a handful of rules cover any payload:
 *
 * - an object's plain fields → a MetadataList, keys read as words;
 * - an object's nested fields → a collapsible section each, named by the key
 *   (a chain of one-key wrappers reads as one path: "Data › Items");
 * - an object of equal-length lists (Open-Meteo's hourly, daily) → a table;
 * - a list of objects that each say what they are in a name and a line
 *   (search results, places) → a List of ListItems, linked when they carry a URL;
 * - a list of small flat objects → a table;
 * - a list of other objects → a divided CollapsibleGroup, each row named by
 *   its title field and tagged with its place or kind;
 * - a list of plain values → tokens;
 * - a string holding JSON → what it holds;
 * - a plain value → text, a link, a date, Yes/No, or a dash.
 *
 * A `<key>_units` object beside `<key>` puts its units on that key's numbers.
 * What the rules don't reach (nesting past MAX_DEPTH, a render that throws)
 * shows as JSON, and the whole payload's JSON is always one tap away.
 */

type Row = Record<string, unknown>;

/** Fields that name a row, in the order they're tried. */
const TITLE_KEYS = ['name', 'title', 'label', 'headline', 'subject', 'id'];
/** Fields that place or sort a row, shown as tokens beside its title. */
const TAG_KEYS = ['country', 'region', 'state', 'admin1', 'city', 'category', 'type', 'kind', 'status'];
const MAX_TAGS = 2;
const MAX_TAG_LENGTH = 24;
/** Fields that say, in a line, what a row is. */
const DESCRIPTION_KEYS = ['description', 'summary', 'snippet', 'extract', 'subtitle', 'address', 'display_name', 'text'];
/** Fields that link a row to its page. */
const LINK_KEYS = ['url', 'link', 'href'];
/** Fields a list row shows beyond its name, line, link and tags, at its end. */
const MAX_LIST_EXTRAS = 2;
/** A list of flat objects with at most this many fields reads as a table. */
const MAX_TABLE_COLUMNS = 6;
/** Rows shown before the rest are left to the JSON view. */
const MAX_ROWS = 50;
/** A list of plain values this short sits inline as tokens beside the other fields. */
const MAX_INLINE_TOKENS = 8;
/** Levels drawn before a subtree shows as JSON. */
const MAX_DEPTH = 8;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function isRow(value: unknown): value is Row {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlain(value: unknown): boolean {
	return value === null || typeof value !== 'object';
}

/** The value's JSON; one JSON can't write (a cycle, a bigint) reads as its string. */
function json(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

/** A string that holds a JSON object or list, parsed; anything else as it came. */
function unpacked(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const text = value.trim();
	if (!/^[[{]/.test(text)) return value;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return value;
	}
}

/** `country_code`, `countryCode` → "Country code". */
function humanize(key: string): string {
	const words = key
		.replace(/([a-z\d])([A-Z])/g, '$1 $2')
		.replace(/[_-]+/g, ' ')
		.trim()
		.toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A unit worth printing: a symbol or abbreviation, not a format name like `iso8601` or `wmo code`. */
function printableUnit(unit: unknown): string | undefined {
	if (typeof unit !== 'string' || unit === '' || /\s/.test(unit) || unit === 'iso8601') return undefined;
	return unit;
}

/** Unit suffixes a key can end in (`distance_m`, `duration_ms`), and the unit each prints as. */
const SUFFIX_UNITS: Record<string, string> = {
	m: 'm',
	km: 'km',
	mi: 'mi',
	ms: 'ms',
	s: 's',
	sec: 's',
	min: 'min',
	h: 'h',
	kg: 'kg',
	g: 'g',
	pct: '%',
	percent: '%',
	c: '°C',
	f: '°F',
	usd: 'USD',
	eur: 'EUR',
	gbp: 'GBP',
	jpy: 'JPY',
};

/** A field's label and unit: from its `<key>_units` entry, else its key's suffix (`distance_m` → "Distance", m). */
function fieldLabel(key: string, units?: Row): { label: string; unit?: string } {
	const listed = printableUnit(units?.[key]);
	if (listed) return { label: humanize(key), unit: listed };
	const match = /^(.+?)[_-]([a-z]+)$/i.exec(key);
	const unit = match?.[2] ? SUFFIX_UNITS[match[2].toLowerCase()] : undefined;
	return match?.[1] && unit ? { label: humanize(match[1]), unit } : { label: humanize(key) };
}

/** The `<key>_units` object beside `key`, if there is one. */
function unitsOf(row: Row, key: string): Row | undefined {
	const units = row[`${key}_units`];
	return isRow(units) ? units : undefined;
}

/** A row's fields, less the units objects its other fields read. */
function shownEntries(row: Row): [string, unknown][] {
	return Object.entries(row).filter(
		([key, value]) => !(key.endsWith('_units') && isRow(value) && key.slice(0, -'_units'.length) in row),
	);
}

function Plain({ value, unit }: { value: unknown; unit?: string }): ReactNode {
	const t = useLabels();
	const locale = useLocale();
	const formats = useMemo(
		() => ({
			// No grouping: ids and years read as written. Six significant digits: a timing reads 1.40369.
			integer: new Intl.NumberFormat(locale, { useGrouping: false }),
			decimal: new Intl.NumberFormat(locale, { useGrouping: false, maximumSignificantDigits: 6 }),
			dateTime: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
			// A bare date is a calendar day, parsed at UTC midnight: read it in UTC, or it slips a day west of Greenwich.
			date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }),
		}),
		[locale],
	);
	if (value === null || value === undefined) return <Text color="secondary">—</Text>;
	if (typeof value === 'boolean') return t(value ? '@theorem.data.yes' : '@theorem.data.no');
	if (typeof value === 'number') {
		const number = (Number.isInteger(value) ? formats.integer : formats.decimal).format(value);
		if (!unit) return number;
		return /^[°%]/.test(unit) ? `${number}${unit}` : `${number} ${unit}`;
	}
	const text = String(value);
	if (/^https?:\/\/\S+$/.test(text)) {
		return (
			<Link href={text} target="_blank" rel="noreferrer">
				{text}
			</Link>
		);
	}
	if (ISO_DATE.test(text)) {
		const date = new Date(text);
		if (!Number.isNaN(date.getTime())) return (text.includes('T') ? formats.dateTime : formats.date).format(date);
	}
	return <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</span>;
}

function Json({ value }: { value: unknown }) {
	return <CodeBlock code={json(value)} language="json" hasLanguageLabel={false} size="sm" width="100%" />;
}

/** Past MAX_ROWS, a note that the rest are in the JSON view. */
function More({ total }: { total: number }) {
	const t = useLabels();
	if (total <= MAX_ROWS) return null;
	return (
		<Text type="supporting" color="secondary">
			{t('@theorem.data.more', { count: String(total - MAX_ROWS) })}
		</Text>
	);
}

/** The field that names a row, if it has one. */
function titleKey(row: Row): string | undefined {
	return TITLE_KEYS.find((key) => typeof row[key] === 'string' || typeof row[key] === 'number');
}

/** Up to two short strings that place or sort a row. */
function tags(row: Row, skip: string | undefined): string[] {
	return TAG_KEYS.filter((key) => {
		const value = row[key];
		return key !== skip && typeof value === 'string' && value.length > 0 && value.length <= MAX_TAG_LENGTH;
	})
		.slice(0, MAX_TAGS)
		.map((key) => row[key] as string);
}

type TableRow = { id: string; cells: Row };

function DataTable({ columns, rows, units }: { columns: readonly string[]; rows: readonly Row[]; units?: Row }) {
	const tableColumns: TableColumn<TableRow>[] = columns.map((key, index) => {
		const { label, unit } = fieldLabel(key, units);
		return {
			key: `c${String(index)}`,
			header: unit ? `${label} (${unit})` : label,
			renderCell: (row) => <Plain value={row.cells[key]} />,
		};
	});
	const data = rows.slice(0, MAX_ROWS).map((cells, index) => ({ id: String(index), cells }));
	return (
		<VStack gap={1}>
			<Table data={data} columns={tableColumns} idKey="id" density="compact" textOverflow="truncate" />
			<More total={rows.length} />
		</VStack>
	);
}

/** A row's parts as a ListItem shows them, if a name and a line say what it is. */
function listRow(item: unknown): { title: string; description: string; href?: string; tags: string[]; extras: [string, unknown][] } | undefined {
	if (!isRow(item) || !Object.values(item).every(isPlain)) return undefined;
	const title = titleKey(item);
	const description = DESCRIPTION_KEYS.find((key) => typeof item[key] === 'string' && item[key] !== '');
	if (!title || !description) return undefined;
	const link = LINK_KEYS.find((key) => typeof item[key] === 'string' && /^https?:\/\//.test(item[key] as string));
	const rowTags = tags(item, title);
	const extras = Object.entries(item).filter(
		([key, value]) =>
			key !== title && key !== description && key !== link && !(TAG_KEYS.includes(key) && rowTags.includes(value as string)),
	);
	if (extras.length > MAX_LIST_EXTRAS) return undefined;
	return {
		title: String(item[title]),
		description: item[description] as string,
		href: link ? (item[link] as string) : undefined,
		tags: rowTags,
		extras,
	};
}

function DataList({ rows, total }: { rows: readonly NonNullable<ReturnType<typeof listRow>>[]; total: number }) {
	return (
		<VStack gap={1}>
			<List hasDividers density="compact">
				{rows.slice(0, MAX_ROWS).map((row, index) => (
					<ListItem
						// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
						key={index}
						label={row.title}
						description={row.description}
						href={row.href}
						target={row.href ? '_blank' : undefined}
						rel={row.href ? 'noreferrer' : undefined}
						endContent={
							row.tags.length + row.extras.length > 0 ? (
								<HStack gap={2} vAlign="center">
									{row.extras.map(([key, value]) => {
										const { label, unit } = fieldLabel(key);
										const shownUnit = typeof value === 'number' ? unit : undefined;
										return (
											<Text key={key} type="supporting" color="secondary">
												{shownUnit ? label : humanize(key)} <Plain value={value} unit={shownUnit} />
											</Text>
										);
									})}
									{row.tags.map((tag) => (
										<Token key={tag} label={tag} size="sm" />
									))}
								</HStack>
							) : undefined
						}
					/>
				))}
			</List>
			<More total={total} />
		</VStack>
	);
}

/** Small flat objects sharing their fields: a table's rows. */
function tableColumns(items: readonly unknown[]): string[] | undefined {
	if (items.length < 2 || !items.every((item) => isRow(item) && Object.values(item).every(isPlain))) return undefined;
	const columns = [...new Set(items.flatMap((item) => Object.keys(item as Row)))];
	return columns.length <= MAX_TABLE_COLUMNS ? columns : undefined;
}

/** An object of equal-length lists of plain values (a column store): a table's columns. */
function columnStore(row: Row): string[] | undefined {
	const entries = shownEntries(row);
	if (entries.length < 2) return undefined;
	const lengths = new Set(entries.map(([, value]) => (Array.isArray(value) && value.every(isPlain) ? value.length : -1)));
	const [length] = lengths;
	return lengths.size === 1 && length !== undefined && length >= 2 ? entries.map(([key]) => key) : undefined;
}

function Rows({ items, depth }: { items: readonly unknown[]; depth: number }) {
	const t = useLabels();
	return (
		<VStack gap={1}>
			<CollapsibleGroup type="multiple" hasDividers density="compact">
				{items.slice(0, MAX_ROWS).map((item, index) => {
					const row = isRow(item) ? item : undefined;
					const key = row ? titleKey(row) : undefined;
					const title = row && key ? String(row[key]) : t('@theorem.data.item', { index: String(index + 1) });
					const rest = row && key ? Object.fromEntries(Object.entries(row).filter(([k]) => k !== key)) : item;
					return (
						<Collapsible
							// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
							key={index}
							value={String(index)}
							trigger={
								<HStack gap={2} vAlign="center" wrap="wrap">
									<Text type="body">{title}</Text>
									{row && tags(row, key).map((tag) => <Token key={tag} label={tag} size="sm" />)}
								</HStack>
							}
						>
							<Node value={rest} depth={depth + 1} />
						</Collapsible>
					);
				})}
			</CollapsibleGroup>
			<More total={items.length} />
		</VStack>
	);
}

/** A nested field, through any chain of one-key wrappers: `{ data: { items: [] } }` → "Data › Items". */
function section(row: Row, key: string): { title: string; value: unknown; units?: Row } {
	const path = [key];
	let inner = unpacked(row[key]);
	let units = unitsOf(row, key);
	while (isRow(inner)) {
		// A units object beside the one field doesn't count: `{ hourly, hourly_units }` is still a wrapper.
		const entries = shownEntries(inner);
		const only = entries.length === 1 ? entries[0] : undefined;
		if (!only || isPlain(unpacked(only[1]))) break;
		path.push(only[0]);
		units = unitsOf(inner, only[0]);
		inner = unpacked(only[1]);
	}
	return { title: path.map(humanize).join(' › '), value: inner, units };
}

function Fields({ row, depth, units }: { row: Row; depth: number; units?: Row }) {
	const entries = shownEntries(row);
	const inline = (value: unknown) => {
		const inner = unpacked(value);
		return isPlain(inner) || (Array.isArray(inner) && inner.length > 0 && inner.length <= MAX_INLINE_TOKENS && inner.every(isPlain));
	};
	const plain = entries.filter(([, value]) => inline(value));
	const nested = entries.filter(([, value]) => !inline(value));
	const fields = plain.length > 0 && (
		<MetadataList label={{ position: 'start', width: '40%' }}>
			{plain.map(([key, value]) => {
				const { label, unit } = fieldLabel(key, units);
				// A suffix unit only reads onto a number: `country_code` stays "Country code".
				const shownUnit = typeof value === 'number' ? unit : undefined;
				return (
					<MetadataListItem key={key} label={shownUnit ? label : humanize(key)}>
						{Array.isArray(unpacked(value)) ? <Node value={value} depth={depth + 1} /> : <Plain value={value} unit={shownUnit} />}
					</MetadataListItem>
				);
			})}
		</MetadataList>
	);
	return (
		<VStack gap={2}>
			{/* Beside a top-level section, plain fields are usually request echo (coordinates, timings): the section leads. */}
			{depth > 0 && fields}
			{nested.length > 0 && (
				<CollapsibleGroup
					type="multiple"
					hasDividers
					density="compact"
					// The top level's sections start open: they're the payload.
					defaultValue={depth === 0 ? nested.map(([key]) => key) : []}
				>
					{nested.map(([key]) => {
						const shown = section(row, key);
						return (
							<Collapsible key={key} value={key} trigger={<Text type="label">{shown.title}</Text>}>
								{/* A section's content steps in so its depth reads. */}
								<VStack paddingInlineStart={3}>
									<Node value={shown.value} depth={depth + 1} units={shown.units} />
								</VStack>
							</Collapsible>
						);
					})}
				</CollapsibleGroup>
			)}
			{depth === 0 && fields}
		</VStack>
	);
}

function Node({ value: raw, depth, units }: { value: unknown; depth: number; units?: Row }): ReactNode {
	const t = useLabels();
	const value = unpacked(raw);
	if (depth > MAX_DEPTH) return <Json value={value} />;
	if (Array.isArray(value)) {
		if (value.length === 0) return <Text color="secondary">{t('@theorem.data.none')}</Text>;
		if (value.every(isPlain)) {
			return (
				<VStack gap={1}>
					<HStack gap={1} wrap="wrap">
						{value.slice(0, MAX_ROWS).map((item, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: plain values can repeat
							<Token key={index} label={item === null ? '—' : String(item)} size="sm" />
						))}
					</HStack>
					<More total={value.length} />
				</VStack>
			);
		}
		const listed = value.map(listRow);
		if (listed.every((row) => row !== undefined)) return <DataList rows={listed} total={value.length} />;
		const columns = tableColumns(value);
		if (columns) return <DataTable columns={columns} rows={value as Row[]} />;
		return <Rows items={value} depth={depth} />;
	}
	if (isRow(value)) {
		if (Object.keys(value).length === 0) return <Text color="secondary">{t('@theorem.data.none')}</Text>;
		const store = columnStore(value);
		if (store) {
			const lists = store.map((key) => value[key] as unknown[]);
			const rows = (lists[0] ?? []).map((_, index) => Object.fromEntries(store.map((key, k) => [key, lists[k]?.[index]])));
			return <DataTable columns={store} rows={rows} units={units} />;
		}
		return <Fields row={value} depth={depth} units={units} />;
	}
	return (
		<Text type="body">
			<Plain value={value} />
		</Text>
	);
}

/** A render the rules didn't foresee throws into the JSON, never into the transcript. */
class ShapeBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	override render(): ReactNode {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

/** A tool call's input, output or failure, or a structured reply, with a switch to its JSON. */
export function ShapedData({ value: raw, title }: { value: unknown; title?: string }) {
	const t = useLabels();
	const [view, setView] = useState<'data' | 'json'>('data');
	const value = unpacked(raw);
	// A plain value reads the same either way; only structure gets the switch.
	const structured = !isPlain(value);
	return (
		<VStack gap={2}>
			<HStack gap={2} vAlign="center" hAlign="between">
				<Text type="supporting" color="secondary">
					{title}
				</Text>
				{structured && (
					<SegmentedControl
						label={t('@theorem.data.view')}
						size="sm"
						value={view}
						onChange={(next) => {
							setView(next === 'json' ? 'json' : 'data');
						}}
					>
						<SegmentedControlItem value="data" label={t('@theorem.data.shaped')} />
						<SegmentedControlItem value="json" label={t('@theorem.data.json')} />
					</SegmentedControl>
				)}
			</HStack>
			{view === 'json' && structured ? (
				<Json value={value} />
			) : (
				<ShapeBoundary fallback={<Json value={value} />}>
					<Node value={value} depth={0} />
				</ShapeBoundary>
			)}
		</VStack>
	);
}
