import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Collapsible, CollapsibleGroup } from '@astryxdesign/core/Collapsible';
import { HStack } from '@astryxdesign/core/HStack';
import { useLocale } from '@astryxdesign/core/i18n';
import { Link } from '@astryxdesign/core/Link';
import { List, ListItem } from '@astryxdesign/core/List';
import { Markdown } from '@astryxdesign/core/Markdown';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Table, type TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { Component, type CSSProperties, type ReactNode, useMemo, useState } from 'react';
import {
  fieldLabel,
  fieldReading,
  isPlain,
  isProse,
  isRow,
  json,
  type ListRow,
  MAX_ROWS,
  type PlainReading,
  plainReading,
  type Row,
  rowHeading,
  type Section,
  type Shape,
  shapeOf,
  splitFields,
  unpacked,
  withUnit,
} from '../client/shaped-data.ts';
import { Arrive, useArrive } from './arrive.tsx';
import { useLabels } from './labels-provider.tsx';
import { keyedByContent } from './row-keys.ts';

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

type Labels = ReturnType<typeof useLabels>;
type Formats = {
  integer: Intl.NumberFormat;
  decimal: Intl.NumberFormat;
  dateTime: Intl.DateTimeFormat;
  date: Intl.DateTimeFormat;
};

/** Each way a plain value reads, drawn. */
const READINGS: {
  [K in PlainReading['kind']]: (
    reading: Extract<PlainReading, { kind: K }>,
    formats: Formats,
    t: Labels,
  ) => ReactNode;
} = {
  none: () => <Text color="secondary">—</Text>,
  boolean: ({ value }, _, t) => t(value ? '@theorem.data.yes' : '@theorem.data.no'),
  number: ({ value, unit }, formats) =>
    withUnit((Number.isInteger(value) ? formats.integer : formats.decimal).format(value), unit),
  link: ({ href }) => (
    <Link href={href} target="_blank" rel="noreferrer">
      {href}
    </Link>
  ),
  date: ({ date }, formats) => formats.date.format(date),
  'date-time': ({ date }, formats) => formats.dateTime.format(date),
  // why: Prose (an answer, a summary) is usually Markdown; headings start small, under the section's own.
  text: ({ text }) =>
    isProse(text) ? (
      <Markdown density="compact" headingLevelStart={4}>
        {text}
      </Markdown>
    ) : (
      <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</span>
    ),
};

function Plain({ value, unit }: { value: unknown; unit?: string }): ReactNode {
  const t = useLabels();
  const locale = useLocale();
  const formats = useMemo(
    () => ({
      // why: No grouping: ids and years read as written. Six significant digits: a timing reads 1.40369.
      integer: new Intl.NumberFormat(locale, { useGrouping: false }),
      decimal: new Intl.NumberFormat(locale, { useGrouping: false, maximumSignificantDigits: 6 }),
      dateTime: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
      // why: A bare date is a calendar day, parsed at UTC midnight: read it in UTC, or it slips a day west of Greenwich.
      date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }),
    }),
    [locale],
  );
  const reading = plainReading(value, unit);
  return (
    READINGS[reading.kind] as (reading: PlainReading, formats: Formats, t: Labels) => ReactNode
  )(reading, formats, t);
}

/** JSON past this many characters isn't laid out or highlighted in full: the page stays responsive however big the payload. */
const LARGE_JSON_CHARS = 200_000;

function Json({ text }: { text: string }) {
  const code = text.length > LARGE_JSON_CHARS ? `${text.slice(0, LARGE_JSON_CHARS)}\n…` : text;
  return <CodeBlock code={code} language="json" hasLanguageLabel={false} size="sm" width="100%" />;
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

type TableRow = { id: string; cells: Row };

function DataTable({
  columns,
  rows,
  units,
}: {
  columns: readonly string[];
  rows: readonly Row[];
  units?: Row;
}) {
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
      <Table
        data={data}
        columns={tableColumns}
        idKey="id"
        density="compact"
        textOverflow="truncate"
      />
      <More total={rows.length} />
    </VStack>
  );
}

/** A list row's extra fields and tags, at its end. */
function ListRowEnd({ row }: { row: ListRow }) {
  if (row.tags.length + row.extras.length === 0) return undefined;
  return (
    <HStack gap={2} vAlign="center">
      {row.extras.map(([key, value]) => {
        const { label, unit } = fieldReading(key, value);
        return (
          <Text key={key} type="supporting" color="secondary">
            {label} <Plain value={value} unit={unit} />
          </Text>
        );
      })}
      {row.tags.map((tag) => (
        <Token key={tag} label={tag} size="sm" />
      ))}
    </HStack>
  );
}

function dataListItem(row: ListRow) {
  return {
    label: row.title,
    description: row.description,
    href: row.href,
    target: row.href ? ('_blank' as const) : undefined,
    rel: row.href ? ('noreferrer' as const) : undefined,
    endContent: <ListRowEnd row={row} />,
  };
}

/** A top-level row eases in with the rest of a returned result. Nested rows stay put. */
function ArrivingDataRow({ row }: { row: ListRow }) {
  const arrive = useArrive();
  return <ListItem className={arrive?.className} style={arrive?.style} {...dataListItem(row)} />;
}

function DataList({ rows, depth }: { rows: readonly ListRow[]; depth: number }) {
  return (
    <VStack gap={1}>
      <List hasDividers density="compact">
        {keyedByContent(rows.slice(0, MAX_ROWS), (row) => row.title).map(({ item: row, key }) =>
          depth === 0 ? (
            <ArrivingDataRow key={key} row={row} />
          ) : (
            <ListItem key={key} {...dataListItem(row)} />
          ),
        )}
      </List>
      <More total={rows.length} />
    </VStack>
  );
}

function ObjectRow({
  item,
  index,
  depth,
  className,
  style,
}: {
  item: unknown;
  index: number;
  depth: number;
  className?: string;
  style?: CSSProperties;
}) {
  const t = useLabels();
  const heading = rowHeading(item);
  return (
    <Collapsible
      className={className}
      style={style}
      value={String(index)}
      trigger={
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Text type="body">
            {heading.title ?? t('@theorem.data.item', { index: String(index + 1) })}
          </Text>
          {heading.tags.map((tag) => (
            <Token key={tag} label={tag} size="sm" />
          ))}
        </HStack>
      }
    >
      <Node value={heading.rest} depth={depth + 1} />
    </Collapsible>
  );
}

/** A top-level object row eases in with the result. One nested under it does not. */
function ArrivingObjectRow({
  item,
  index,
  depth,
}: {
  item: unknown;
  index: number;
  depth: number;
}) {
  const arrive = useArrive();
  return (
    <ObjectRow
      item={item}
      index={index}
      depth={depth}
      className={arrive?.className}
      style={arrive?.style}
    />
  );
}

function Rows({ items, depth }: { items: readonly unknown[]; depth: number }) {
  return (
    <VStack gap={1}>
      <CollapsibleGroup type="multiple" hasDividers density="compact">
        {keyedByContent(items.slice(0, MAX_ROWS), (item) => JSON.stringify(item) ?? '').map(
          ({ item, index, key }) =>
            depth === 0 ? (
              <ArrivingObjectRow key={key} item={item} index={index} depth={depth} />
            ) : (
              <ObjectRow key={key} item={item} index={index} depth={depth} />
            ),
        )}
      </CollapsibleGroup>
      <More total={items.length} />
    </VStack>
  );
}

function FieldSection({
  shown,
  depth,
  className,
  style,
}: {
  shown: Section;
  depth: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <Collapsible
      className={className}
      style={style}
      value={shown.key}
      trigger={<Text type="label">{shown.title}</Text>}
    >
      <VStack paddingInlineStart={3}>
        <Node value={shown.value} depth={depth + 1} units={shown.units} />
      </VStack>
    </Collapsible>
  );
}

function ArrivingFieldSection({ shown, depth }: { shown: Section; depth: number }) {
  const arrive = useArrive();
  return (
    <FieldSection shown={shown} depth={depth} className={arrive?.className} style={arrive?.style} />
  );
}

function Fields({ row, depth, units }: { row: Row; depth: number; units?: Row }) {
  const { plain, sections } = splitFields(row);
  const fields = plain.length > 0 && (
    <MetadataList label={{ position: 'start', width: '40%' }}>
      {plain.map(([key, value]) => {
        const { label, unit } = fieldReading(key, value, units);
        return (
          <MetadataListItem key={key} label={label}>
            {Array.isArray(unpacked(value)) ? (
              <Node value={value} depth={depth + 1} />
            ) : (
              <Plain value={value} unit={unit} />
            )}
          </MetadataListItem>
        );
      })}
    </MetadataList>
  );
  return (
    <VStack gap={2}>
      {/* why: Beside a top-level section, plain fields are usually request echo (coordinates, timings): the section leads. */}
      {depth > 0 && fields}
      {sections.length > 0 && (
        <CollapsibleGroup
          type="multiple"
          hasDividers
          density="compact"
          // why: The top level's first section starts open: it's usually the payload. The rest wait to be asked for.
          defaultValue={depth === 0 ? sections.slice(0, 1).map((shown) => shown.key) : []}
        >
          {sections.map((shown) =>
            depth === 0 ? (
              <ArrivingFieldSection key={shown.key} shown={shown} depth={depth} />
            ) : (
              <FieldSection key={shown.key} shown={shown} depth={depth} />
            ),
          )}
        </CollapsibleGroup>
      )}
      {depth === 0 && fields ? <Arrive>{fields}</Arrive> : null}
    </VStack>
  );
}

type NodeProps = { value: unknown; depth: number; units?: Row; t: Labels };

/** Each shape a value takes, drawn. */
const SHAPES: {
  [K in Shape['kind']]: (shape: Extract<Shape, { kind: K }>, props: NodeProps) => ReactNode;
} = {
  json: (_, { value }) => <Json text={json(value)} />,
  none: (_, { t }) => <Text color="secondary">{t('@theorem.data.none')}</Text>,
  plain: (_, { value }) => (
    <Text type="body">
      <Plain value={value} />
    </Text>
  ),
  tokens: ({ items }) => (
    <VStack gap={1}>
      <HStack gap={1} wrap="wrap">
        {keyedByContent(items.slice(0, MAX_ROWS), (item) => String(item)).map(({ item, key }) => (
          <Token key={key} label={item === null ? '—' : String(item)} size="sm" />
        ))}
      </HStack>
      <More total={items.length} />
    </VStack>
  ),
  list: ({ rows }, { depth }) => <DataList rows={rows} depth={depth} />,
  table: ({ columns, rows }, { units }) => (
    <DataTable columns={columns} rows={rows} units={units} />
  ),
  rows: ({ items }, { depth }) => <Rows items={items} depth={depth} />,
  fields: ({ row }, { depth, units }) => <Fields row={row} depth={depth} units={units} />,
};

function Node({
  value: raw,
  depth,
  units,
}: {
  value: unknown;
  depth: number;
  units?: Row;
}): ReactNode {
  const t = useLabels();
  const value = unpacked(raw);
  const shape = shapeOf(value, depth);
  const body = (SHAPES[shape.kind] as (shape: Shape, props: NodeProps) => ReactNode)(shape, {
    value,
    depth,
    units,
    t,
  });
  // why: A list, a set of rows, or an object's sections stagger their own children. Anything else at the top of a result is one arrival.
  if (depth !== 0 || shape.kind === 'list' || shape.kind === 'rows' || shape.kind === 'fields') {
    return body;
  }
  return <Arrive>{body}</Arrive>;
}

/** A render the rules didn't foresee throws into the JSON, never into the transcript. */
class ShapeBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export type ShapedDataProps = {
  value: unknown;
  title?: string;
  /** Drawn above the data in its data view (a tool result's figures and charts); a render that throws falls back to the JSON with it. */
  lead?: ReactNode;
  /** Top-level fields the lead already shows: the data view leaves them out, the JSON keeps them. */
  ledKeys?: readonly string[];
};

/** A tool call's input, output or failure, or a structured reply, with a switch to its JSON. */
export function ShapedData({ value: raw, title, lead, ledKeys = [] }: ShapedDataProps) {
  const t = useLabels();
  const locale = useLocale();
  const [view, setView] = useState<'data' | 'json'>('data');
  const value = unpacked(raw);
  const structured = !isPlain(value);
  const text = useMemo(() => (structured ? json(value) : ''), [structured, value]);
  const rest = useMemo(() => {
    if (!ledKeys.length || !isRow(value)) return value;
    const left = Object.entries(value).filter(([key]) => !ledKeys.includes(key));
    return left.length ? Object.fromEntries(left) : undefined;
  }, [value, ledKeys]);
  if (text.length > LARGE_JSON_CHARS) {
    const size = new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'kilobyte',
      maximumFractionDigits: 0,
    }).format(LARGE_JSON_CHARS / 1000);
    return (
      <VStack gap={2}>
        <Text type="supporting" color="secondary">
          {title}
        </Text>
        <Text type="supporting" color="secondary">
          {t('@theorem.data.large', { size })}
        </Text>
        <Json text={text} />
      </VStack>
    );
  }
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
        <Json text={text} />
      ) : (
        <ShapeBoundary fallback={<Json text={text} />}>
          <VStack gap={3}>
            {lead}
            {rest === undefined ? null : <Node value={rest} depth={0} />}
          </VStack>
        </ShapeBoundary>
      )}
    </VStack>
  );
}
