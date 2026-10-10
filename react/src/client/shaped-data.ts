/**
 * The rules `ShapedData` draws a payload by, as plain decisions: which shape a
 * value takes, what a row is called, what a field's label and unit are. The
 * component only maps each decision to its Astryx part.
 */

export type Row = Record<string, unknown>;

/** Fields that name a row, in the order they're tried. */
const TITLE_KEYS = ['name', 'title', 'label', 'headline', 'subject', 'id'];
/** Fields that place or sort a row, shown as tokens beside its title. */
const TAG_KEYS = [
  'country',
  'region',
  'state',
  'admin1',
  'city',
  'category',
  'type',
  'kind',
  'status',
];
const MAX_TAGS = 2;
const MAX_TAG_LENGTH = 24;
/** Fields that say, in a line, what a row is. */
const DESCRIPTION_KEYS = [
  'description',
  'summary',
  'snippet',
  'extract',
  'subtitle',
  'address',
  'display_name',
  'text',
];
/** Fields that link a row to its page. */
const LINK_KEYS = ['url', 'link', 'href'];
/** Fields a list row shows beyond its name, line, link and tags, at its end. */
const MAX_LIST_EXTRAS = 2;
/** A list of flat objects with at most this many fields reads as a table. */
const MAX_TABLE_COLUMNS = 6;
/** Rows shown before the rest are left to the JSON view. */
export const MAX_ROWS = 50;
/** A list of plain values this short sits inline as tokens beside the other fields. */
const MAX_INLINE_TOKENS = 8;
/** Levels drawn before a subtree shows as JSON. */
const MAX_DEPTH = 8;

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPlain(value: unknown): boolean {
  return value === null || typeof value !== 'object';
}

const UNREADABLE = '[Unreadable]';
const NO_TO_JSON = Symbol('no toJSON');

/** A read that throws reads as a marker. */
function readSafe(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return UNREADABLE;
  }
}

/** What the value's own toJSON gives, made safe; NO_TO_JSON when it has none. */
function viaToJSON(value: object, inside: object[]): unknown {
  const own = (value as { toJSON?: () => unknown }).toJSON;
  return typeof own === 'function' ? jsonSafe(own.call(value), inside) : NO_TO_JSON;
}

/**
 * What JSON.stringify can't take, made plain: a cycle, a BigInt, a property
 * that throws when read. Each becomes a marker in place, so the rest still shows.
 */
function jsonSafe(value: unknown, ancestors: object[] = []): unknown {
  if (typeof value === 'bigint') return String(value);
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.includes(value)) return '[Circular]';
  const inside = [...ancestors, value];
  const converted = readSafe(() => viaToJSON(value, inside));
  if (converted !== NO_TO_JSON) return converted;
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item, inside));
  return Object.fromEntries(
    Object.keys(value).map((key) => [key, readSafe(() => jsonSafe((value as Row)[key], inside))]),
  );
}

/** The value as indented JSON, whatever it holds. */
export function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return JSON.stringify(jsonSafe(value), null, 2) ?? String(value);
  }
}

/** A string that holds a JSON object or list, parsed; anything else as it came. */
export function unpacked(value: unknown): unknown {
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
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A unit worth printing: a symbol or abbreviation, not a format name like `iso8601` or `wmo code`. */
export function printableUnit(unit: unknown): string | undefined {
  if (typeof unit !== 'string' || unit === '' || /\s/.test(unit) || unit === 'iso8601')
    return undefined;
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

/** The unit a key's suffix names, and the key without it: `distance_m` → Distance, m. */
function suffixUnit(key: string): { label: string; unit: string } | undefined {
  const match = /^(.+?)[_-]([a-z]+)$/i.exec(key);
  const unit = match ? SUFFIX_UNITS[(match[2] ?? '').toLowerCase()] : undefined;
  return match?.[1] && unit ? { label: humanize(match[1]), unit } : undefined;
}

/** A column's label and unit: from its `<key>_units` entry, else its key's suffix. */
export function fieldLabel(key: string, units?: Row): { label: string; unit?: string } {
  const listed = printableUnit(units?.[key]);
  if (listed) return { label: humanize(key), unit: listed };
  return suffixUnit(key) ?? { label: humanize(key) };
}

/** A field's label and the unit its value reads with. A unit only reads onto a number: `country_code` stays "Country code". */
export function fieldReading(
  key: string,
  value: unknown,
  units?: Row,
): { label: string; unit?: string } {
  if (typeof value !== 'number') return { label: humanize(key) };
  return fieldLabel(key, units);
}

/** The `<key>_units` object beside `key`, if there is one. */
export function unitsOf(row: Row, key: string): Row | undefined {
  const units = row[`${key}_units`];
  return isRow(units) ? units : undefined;
}

/** A row's fields, less the units objects its other fields read. */
export function shownEntries(row: Row): [string, unknown][] {
  return Object.entries(row).filter(
    ([key, value]) =>
      !(key.endsWith('_units') && isRow(value) && key.slice(0, -'_units'.length) in row),
  );
}

/** How a plain value reads. */
export type PlainReading =
  | { kind: 'none' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'number'; value: number; unit?: string }
  | { kind: 'link'; href: string }
  | { kind: 'date'; date: Date }
  | { kind: 'date-time'; date: Date }
  | { kind: 'text'; text: string };

/** A string that's a date: a bare day or a moment. */
function dateReading(text: string): PlainReading | undefined {
  if (!ISO_DATE.test(text)) return undefined;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return undefined;
  return text.includes('T') ? { kind: 'date-time', date } : { kind: 'date', date };
}

export function plainReading(value: unknown, unit?: string): PlainReading {
  if (value === null || value === undefined) return { kind: 'none' };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (typeof value === 'number')
    return unit ? { kind: 'number', value, unit } : { kind: 'number', value };
  const text = String(value);
  if (/^https?:\/\/\S+$/.test(text)) return { kind: 'link', href: text };
  return dateReading(text) ?? { kind: 'text', text };
}

/** A formatted number with its unit: symbols sit close (21°C, 35%), words stand apart (320 m). */
export function withUnit(number: string, unit?: string): string {
  if (!unit) return number;
  return /^[°%]/.test(unit) ? `${number}${unit}` : `${number} ${unit}`;
}

/** The field that names a row, if it has one. */
export function titleKey(row: Row): string | undefined {
  return TITLE_KEYS.find((key) => typeof row[key] === 'string' || typeof row[key] === 'number');
}

/** Up to two short strings that place or sort a row. */
function tags(row: Row, skip: string | undefined): string[] {
  return TAG_KEYS.filter((key) => {
    const value = row[key];
    return (
      key !== skip &&
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= MAX_TAG_LENGTH
    );
  })
    .slice(0, MAX_TAGS)
    .map((key) => row[key] as string);
}

/** A row of a list as a ListItem shows it. */
export type ListRow = {
  title: string;
  description: string;
  href?: string;
  tags: string[];
  extras: [string, unknown][];
};

/** A flat row's parts, if a name and a line say what it is. */
function listRow(item: unknown): ListRow | undefined {
  if (!isRow(item) || !Object.values(item).every(isPlain)) return undefined;
  const title = titleKey(item);
  const description = DESCRIPTION_KEYS.find(
    (key) => typeof item[key] === 'string' && item[key] !== '',
  );
  if (!title || !description) return undefined;
  const link = LINK_KEYS.find(
    (key) => typeof item[key] === 'string' && /^https?:\/\//.test(item[key] as string),
  );
  const rowTags = tags(item, title);
  const shown = new Set([title, description, link]);
  const extras = Object.entries(item).filter(
    ([key, value]) =>
      !shown.has(key) && !(TAG_KEYS.includes(key) && rowTags.includes(value as string)),
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

/** A collapsible row's heading and what it opens to: a titled row loses its title field; else it's named by its place. */
export function rowHeading(item: unknown): { title?: string; tags: string[]; rest: unknown } {
  if (!isRow(item)) return { tags: [], rest: item };
  const key = titleKey(item);
  if (!key) return { tags: tags(item, undefined), rest: item };
  return {
    title: String(item[key]),
    tags: tags(item, key),
    rest: Object.fromEntries(Object.entries(item).filter(([k]) => k !== key)),
  };
}

/** Small flat objects sharing their fields: a table's rows. */
function tableColumns(items: readonly unknown[]): string[] | undefined {
  if (items.length < 2 || !items.every((item) => isRow(item) && Object.values(item).every(isPlain)))
    return undefined;
  const columns = [...new Set(items.flatMap((item) => Object.keys(item as Row)))];
  return columns.length <= MAX_TABLE_COLUMNS ? columns : undefined;
}

/** An object of equal-length lists of plain values (a column store): a table's columns. */
export function columnStore(row: Row): string[] | undefined {
  const entries = shownEntries(row);
  if (entries.length < 2) return undefined;
  const lengths = new Set(
    entries.map(([, value]) => (Array.isArray(value) && value.every(isPlain) ? value.length : -1)),
  );
  const [length] = lengths;
  return lengths.size === 1 && length !== undefined && length >= 2
    ? entries.map(([key]) => key)
    : undefined;
}

/** A column store's lists, turned into rows. */
export function storeRows(row: Row, columns: readonly string[]): Row[] {
  const lists = columns.map((key) => row[key] as unknown[]);
  return (lists[0] ?? []).map((_, index) =>
    Object.fromEntries(columns.map((key, k) => [key, lists[k]?.[index]])),
  );
}

/** The shape a value is drawn as. */
export type Shape =
  | { kind: 'json' }
  | { kind: 'none' }
  | { kind: 'plain' }
  | { kind: 'tokens'; items: unknown[] }
  | { kind: 'list'; rows: ListRow[] }
  | { kind: 'table'; columns: string[]; rows: Row[] }
  | { kind: 'rows'; items: unknown[] }
  | { kind: 'fields'; row: Row };

function listShape(items: unknown[]): Shape {
  if (items.length === 0) return { kind: 'none' };
  if (items.every(isPlain)) return { kind: 'tokens', items };
  const listed = items.map(listRow);
  if (listed.every((row) => row !== undefined)) return { kind: 'list', rows: listed };
  const columns = tableColumns(items);
  return columns ? { kind: 'table', columns, rows: items as Row[] } : { kind: 'rows', items };
}

function rowShape(row: Row): Shape {
  if (Object.keys(row).length === 0) return { kind: 'none' };
  const store = columnStore(row);
  return store
    ? { kind: 'table', columns: store, rows: storeRows(row, store) }
    : { kind: 'fields', row };
}

/** How a value (already unpacked) at `depth` is drawn. */
export function shapeOf(value: unknown, depth: number): Shape {
  if (depth > MAX_DEPTH) return { kind: 'json' };
  if (Array.isArray(value)) return listShape(value);
  return isRow(value) ? rowShape(value) : { kind: 'plain' };
}

/** Text this long, or on several lines, reads as prose: full width, as Markdown. */
const PROSE_CHARS = 160;

export function isProse(value: unknown): value is string {
  return typeof value === 'string' && (value.length > PROSE_CHARS || value.includes('\n'));
}

/** A field that sits in the field list: a plain value (prose aside), or a short list of them. */
function isInline(value: unknown): boolean {
  const inner = unpacked(value);
  if (isProse(inner)) return false;
  if (isPlain(inner)) return true;
  return (
    Array.isArray(inner) &&
    inner.length > 0 &&
    inner.length <= MAX_INLINE_TOKENS &&
    inner.every(isPlain)
  );
}

/** A nested field, through any chain of one-key wrappers: `{ data: { items: [] } }` → "Data › Items". */
export type Section = { key: string; title: string; value: unknown; units?: Row };

function section(row: Row, key: string): Section {
  const path = [key];
  let inner = unpacked(row[key]);
  let units = unitsOf(row, key);
  while (isRow(inner)) {
    // why: A units object beside the one field doesn't count: `{ hourly, hourly_units }` is still a wrapper.
    const entries = shownEntries(inner);
    const only = entries.length === 1 ? entries[0] : undefined;
    if (!only || isPlain(unpacked(only[1]))) break;
    path.push(only[0]);
    units = unitsOf(inner, only[0]);
    inner = unpacked(only[1]);
  }
  return { key, title: path.map(humanize).join(' › '), value: inner, units };
}

/** An object's fields split: plain ones for the field list, nested ones as sections. */
export function splitFields(row: Row): { plain: [string, unknown][]; sections: Section[] } {
  const entries = shownEntries(row);
  return {
    plain: entries.filter(([, value]) => isInline(value)),
    sections: entries.filter(([, value]) => !isInline(value)).map(([key]) => section(row, key)),
  };
}
