import { isRecord } from '../util/record.ts';

/** A filled value longer than this is cut and ends in an ellipsis. */
const MAX_VALUE_CHARS = 40;

const PLACEHOLDER = /\{([^{}]+)\}/g;
const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/**
 * The dot paths a label names, in order: `"Found {results.0.name}"` → `results.0.name`. A
 * number steps into a list by position from 0; a name steps into a group.
 */
export function activityLabelPlaceholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => (match[1] ?? '').trim());
}

/** A list's item by its number from 0, or a group's field by name. */
function valueAt(source: unknown, path: string): unknown {
  let value = source;
  for (const key of path.split('.')) {
    if (Array.isArray(value) && /^\d+$/.test(key)) value = value[Number(key)];
    else if (isRecord(value) && Object.hasOwn(value, key)) value = value[key];
    else return undefined;
  }
  return value;
}

function labelValue(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? NUMBER.format(value) : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS - 1).trimEnd()}…` : text;
}

/**
 * A tool's activity label with each `{path}` filled from the call: its input first, then
 * its output. Only text and numbers fill a placeholder; when one has no such value the label
 * is `undefined`, and the transcript names the tool instead.
 */
export function fillActivityLabel(
  template: string | undefined,
  values: { input: unknown; output?: unknown },
): string | undefined {
  if (!template?.trim()) return undefined;
  let missing = false;
  const filled = template.replace(PLACEHOLDER, (_, raw: string) => {
    const path = raw.trim();
    const value =
      labelValue(valueAt(values.input, path)) ?? labelValue(valueAt(values.output, path));
    if (value === undefined) missing = true;
    return value ?? '';
  });
  return missing ? undefined : filled.trim();
}
