import { isRecord } from '../util/record.ts';

const MAX_VALUE_CHARS = 40;
const PLACEHOLDER = /\{([^{}]+)\}/g;
// Control and bidi-override characters would let a tool's output restyle or reorder the label.
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/gu;
const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export function activityLabelPlaceholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => (match[1] ?? '').trim());
}

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
  const chars = [...value.replace(UNPRINTABLE, ' ').replace(/\s+/g, ' ').trim()];
  if (chars.length === 0) return undefined;
  if (chars.length <= MAX_VALUE_CHARS) return chars.join('');
  const head = chars.slice(0, MAX_VALUE_CHARS - 1).join('');
  return `${head.trimEnd()}…`;
}

/**
 * Fills each `{path}` from the input, then the output. Only text and numbers fill; if any
 * placeholder can't, the whole label is `undefined` and the transcript names the tool instead.
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
