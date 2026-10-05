/**
 * What a tool's result leads with, above its data: the figures that answer it,
 * the series worth a chart, and the images it links. Plain decisions over the
 * value alone, so any tool's output gets them without a schema saying so; the
 * data itself still reads in full below, drawn by `ShapedData`.
 *
 * @module
 */

import {
  columnStore,
  fieldLabel,
  humanize,
  ISO_DATE,
  isPlain,
  isRow,
  printableUnit,
  type Row,
  shownEntries,
  storeRows,
  titleKey,
  unitsOf,
  unpacked,
} from './shaped-data.ts';

/** One number that answers the call, as a stat card shows it. */
export type ResultFigure = { key: string; label: string; value: number; unit?: string };

/** One numeric field drawn across a chart's rows. */
export type ResultSeries = { key: string; label: string; unit?: string };

/** A time chart draws its series over dates; a category chart ranks rows by one series. */
export type ResultChart =
  | { kind: 'time'; key: string; title: string; x: string; series: ResultSeries[]; rows: Row[] }
  | {
      kind: 'category';
      key: string;
      title: string;
      series: ResultSeries;
      rows: { label: string; value: number }[];
    };

export type ResultImage = { src: string; alt: string };

export type ResultLayout = {
  figures: ResultFigure[];
  charts: ResultChart[];
  images: ResultImage[];
};

/** Media a tool returned beside its value, as the complete event carries it. */
export type ResultMedia = { type: string; mimeType?: string; data?: string };

/** What a call returned to see or hear: its image parts, then the images its value links; its audio parts. */
export type ReturnedMedia = { images: ResultImage[]; audio: { src: string; mimeType?: string }[] };

const MAX_FIGURES = 4;
const MAX_CHARTS = 3;
/** Series one time chart overlays, when they share a unit. */
const MAX_SERIES = 3;
/** Bars a category chart ranks. */
const MAX_BARS = 8;
const MAX_IMAGES = 6;
/** Rows a list needs before it reads as a chart. */
const MIN_POINTS = 3;
/** Levels searched for charts and images. */
const MAX_SEARCH_DEPTH = 3;

/** Numbers that locate or name a thing rather than measure it. */
const NOT_A_MEASURE =
  /(^|_)(id|ids|lat|lon|lng|latitude|longitude|offset|interval|index|rank|order)$|Id$|^(generationtime_ms|utc_offset_seconds)$/i;
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

function isImageUrl(text: string): boolean {
  if (/\s/.test(text)) return false;
  try {
    const url = new URL(text);
    return (url.protocol === 'http:' || url.protocol === 'https:') && IMAGE_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

function isMeasure(key: string): boolean {
  return !NOT_A_MEASURE.test(key);
}

/** A code-like key (`USD`, `EUR`) keeps its case; others read as words. */
function keyLabel(key: string): string {
  return /^[A-Z][A-Z0-9]{1,5}$/.test(key) ? key : humanize(key);
}

/** A field's reading, unless its units say it's a code (`wmo code`, `iso8601`, a flag with no unit). */
function measured(
  key: string,
  units: Row | undefined,
): { label: string; unit?: string } | undefined {
  if (!isMeasure(key)) return undefined;
  if (units && key in units && printableUnit(units[key]) === undefined) return undefined;
  const { label, unit } = fieldLabel(key, units);
  return { label: keyLabel(key) === key ? key : label, unit };
}

function figuresOf(row: Row, units: Row | undefined): ResultFigure[] {
  const figures: ResultFigure[] = [];
  for (const [key, value] of shownEntries(row)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const reading = measured(key, units);
    if (reading) figures.push({ key, value, ...reading });
  }
  // why: Numbers with a unit say more at a glance: they lead.
  return figures
    .sort((a, b) => Number(b.unit !== undefined) - Number(a.unit !== undefined))
    .slice(0, MAX_FIGURES);
}

/**
 * The figures: the numbers of the first nested object of plain fields (the
 * `current` reading beside a forecast, a conversion's `rates`), else the
 * value's own top-level numbers. Beside a nested reading, top-level numbers
 * are usually the request echoed back.
 */
function leadFigures(value: unknown): ResultFigure[] {
  if (!isRow(value)) return [];
  for (const [key, entry] of shownEntries(value)) {
    const inner = unpacked(entry);
    if (!isRow(inner) || columnStore(inner)) continue;
    const plain = Object.values(inner);
    if (plain.length === 0 || !plain.every(isPlain)) continue;
    const figures = figuresOf(inner, unitsOf(value, key));
    if (figures.length > 0) return figures;
  }
  return figuresOf(value, undefined);
}

function distinct(rows: readonly Row[], key: string): number {
  return new Set(rows.map((row) => row[key])).size;
}

/** Fields every row holds as a number, that measure something and vary. */
function numericSeries(rows: readonly Row[], skip: string, units: Row | undefined): ResultSeries[] {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter(
    (key) =>
      key !== skip &&
      rows.every((row) => typeof row[key] === 'number' || row[key] === null) &&
      distinct(rows, key) > 1,
  );
  return keys.flatMap((key) => {
    const reading = measured(key, units);
    return reading ? [{ key, ...reading }] : [];
  });
}

/** The field every row holds as an ISO date, if one does. */
function dateKey(rows: readonly Row[]): string | undefined {
  const [first] = rows;
  if (!first) return undefined;
  return Object.keys(first).find((key) =>
    rows.every((row) => typeof row[key] === 'string' && ISO_DATE.test(row[key] as string)),
  );
}

/** Series that share leading words ("Temperature 2m max", "… min") are titled by them, and each keeps the rest. */
function sharedWords(
  series: readonly ResultSeries[],
): { title: string; series: ResultSeries[] } | undefined {
  const words = series.map((one) => one.label.split(' '));
  const [first = []] = words;
  let shared = 0;
  while (
    shared < first.length &&
    words.every((one) => one.length > shared + 1 && one[shared] === first[shared])
  )
    shared++;
  if (!shared) return undefined;
  return {
    title: first.slice(0, shared).join(' '),
    series: series.map((one, at) => {
      const rest = (words[at] ?? []).slice(shared).join(' ');
      return { ...one, label: rest.charAt(0).toUpperCase() + rest.slice(1) };
    }),
  };
}

/** Series over time, one chart per unit they share, each overlaying up to MAX_SERIES. */
function timeCharts(
  path: string,
  title: string,
  rows: Row[],
  x: string,
  units: Row | undefined,
): ResultChart[] {
  const byUnit = new Map<string, ResultSeries[]>();
  for (const series of numericSeries(rows, x, units)) {
    const group = byUnit.get(series.unit ?? '') ?? [];
    group.push(series);
    byUnit.set(series.unit ?? '', group);
  }
  return [...byUnit.values()].map((group) => {
    const shown = group.slice(0, MAX_SERIES);
    const shared = shown.length > 1 ? sharedWords(shown) : undefined;
    return {
      kind: 'time',
      key: `${path}:${shown.map((series) => series.key).join('+')}`,
      title:
        shown.length === 1
          ? (shown[0]?.label ?? title)
          : (shared?.title ?? (title || shown.map((series) => series.label).join(' · '))),
      x,
      series: shared?.series ?? shown,
      rows,
    };
  });
}

/** The field that tells rows apart: their title field, or else the shortest text field that differs on every row ("Paris" ×4 → city, suburb, town). */
function labelKey(rows: readonly Row[]): string | undefined {
  const [first] = rows;
  const title = first ? titleKey(first) : undefined;
  if (
    !first ||
    !title ||
    !rows.every((row) => typeof row[title] === 'string' || typeof row[title] === 'number')
  )
    return undefined;
  if (distinct(rows, title) === rows.length) return title;
  const length = (key: string) => rows.reduce((sum, row) => sum + String(row[key]).length, 0);
  const [unique] = Object.keys(first)
    .filter(
      (key) =>
        rows.every((row) => typeof row[key] === 'string') && distinct(rows, key) === rows.length,
    )
    .sort((a, b) => length(a) - length(b));
  return unique ?? title;
}

/** Rows named by a title field, ranked by each series that varies, most varied first. */
function categoryCharts(
  path: string,
  title: string,
  rows: Row[],
  units: Row | undefined,
): ResultChart[] {
  const label = labelKey(rows);
  if (!label) return [];
  return numericSeries(rows, label, units)
    .sort((a, b) => distinct(rows, b.key) - distinct(rows, a.key))
    .map((series) => ({
      kind: 'category',
      key: `${path}:${series.key}`,
      title: title ? `${title} · ${series.label}` : series.label,
      series,
      rows: rows
        .filter((row) => typeof row[series.key] === 'number')
        .map((row) => ({ label: String(row[label]), value: row[series.key] as number }))
        .sort((a, b) => b.value - a.value)
        .slice(0, MAX_BARS),
    }));
}

function rowsCharts(
  path: string,
  title: string,
  rows: Row[],
  units: Row | undefined,
): ResultChart[] {
  if (rows.length < MIN_POINTS) return [];
  const x = dateKey(rows);
  return x ? timeCharts(path, title, rows, x, units) : categoryCharts(path, title, rows, units);
}

/** Charts anywhere in the value, to MAX_SEARCH_DEPTH: lists of rows, column stores, and objects of numbers. */
function chartsIn(
  value: unknown,
  path: string,
  title: string,
  units: Row | undefined,
  depth: number,
): ResultChart[] {
  if (depth > MAX_SEARCH_DEPTH) return [];
  if (Array.isArray(value)) {
    const rows = value.map(unpacked);
    return rows.every(isRow) ? rowsCharts(path, title, rows, units) : [];
  }
  if (!isRow(value)) return [];
  const store = columnStore(value);
  if (store) return rowsCharts(path, title, storeRows(value, store), units);
  const entries = shownEntries(value);
  const numbers = entries.filter(([key, entry]) => typeof entry === 'number' && isMeasure(key));
  if (depth > 0 && numbers.length >= MIN_POINTS && numbers.length === entries.length) {
    const rows = numbers.map(([key, entry]) => ({ label: keyLabel(key), value: entry as number }));
    return [
      {
        kind: 'category',
        key: path,
        title,
        series: { key: 'value', label: title },
        rows: rows.sort((a, b) => b.value - a.value).slice(0, MAX_BARS),
      },
    ];
  }
  return entries.flatMap(([key, entry]) =>
    chartsIn(
      unpacked(entry),
      path ? `${path}.${key}` : key,
      depth === 0 ? humanize(key) : `${title} › ${humanize(key)}`,
      unitsOf(value, key),
      depth + 1,
    ),
  );
}

/** Image URLs anywhere in the value, first found first, each once. */
function imagesIn(
  value: unknown,
  key: string,
  depth: number,
  found: Map<string, ResultImage>,
): void {
  if (found.size >= MAX_IMAGES || depth > MAX_SEARCH_DEPTH + 1) return;
  const inner = unpacked(value);
  if (typeof inner === 'string') {
    if (isImageUrl(inner) && !found.has(inner))
      found.set(inner, { src: inner, alt: humanize(key || 'image') });
    return;
  }
  if (Array.isArray(inner)) {
    for (const item of inner) imagesIn(item, key, depth + 1, found);
    return;
  }
  if (isRow(inner))
    for (const [child, entry] of Object.entries(inner)) imagesIn(entry, child, depth + 1, found);
}

/** What a tool's output leads with. Empty when nothing stands out: the data alone reads best. */
export function layoutResult(output: unknown): ResultLayout {
  const value = unpacked(output);
  const images = new Map<string, ResultImage>();
  imagesIn(value, '', 0, images);
  return {
    figures: leadFigures(value),
    charts: chartsIn(value, '', '', undefined, 0).slice(0, MAX_CHARTS),
    images: [...images.values()],
  };
}

function mediaSrc(part: ResultMedia): string | undefined {
  return part.mimeType && part.data ? `data:${part.mimeType};base64,${part.data}` : undefined;
}

/** The images and audio a call returned, each with its bytes; parts without them are left out. */
export function returnedMedia(
  layout: ResultLayout,
  parts: readonly ResultMedia[],
  imageAlt: string,
): ReturnedMedia {
  const sourced = parts.flatMap((part) => {
    const src = mediaSrc(part);
    return src ? [{ type: part.type, src, mimeType: part.mimeType }] : [];
  });
  return {
    images: [
      ...sourced.filter((part) => part.type === 'image').map(({ src }) => ({ src, alt: imageAlt })),
      ...layout.images,
    ],
    audio: sourced
      .filter((part) => part.type === 'audio')
      .map(({ src, mimeType }) => ({ src, ...(mimeType ? { mimeType } : {}) })),
  };
}

/** Whether the result has anything to lead with above its data. */
export function hasLead(layout: ResultLayout, media: ReturnedMedia): boolean {
  return (
    layout.figures.length + layout.charts.length + media.images.length + media.audio.length > 0
  );
}

const DAY_MS = 86_400_000;
/** Days a time chart names by weekday; longer runs read as dates. */
const MAX_WEEKDAYS = 10;

/**
 * How a time chart's dates read, on its axis and in its tooltip: hours within
 * a day, else dates. A bare date is a calendar day, parsed at UTC midnight, so
 * it reads in UTC and doesn't slip a day.
 */
export function timeFormats(dates: readonly string[]): {
  tick: Intl.DateTimeFormatOptions;
  when: Intl.DateTimeFormatOptions;
} {
  if (dates.some((date) => date.includes('T'))) {
    const span = Math.abs(Date.parse(dates.at(-1) ?? '') - Date.parse(dates[0] ?? ''));
    return {
      tick: span <= DAY_MS ? { hour: 'numeric' } : { month: 'short', day: 'numeric' },
      when: { dateStyle: 'medium', timeStyle: 'short' },
    };
  }
  return {
    tick:
      dates.length <= MAX_WEEKDAYS
        ? { weekday: 'short', timeZone: 'UTC' }
        : { month: 'short', day: 'numeric', timeZone: 'UTC' },
    when: { dateStyle: 'medium', timeZone: 'UTC' },
  };
}
