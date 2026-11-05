import { CIRCULAR } from '../../guardrails/serialize.ts';

/** `value` with every string in it put through `map`. A value that contains itself becomes `CIRCULAR` where it repeats, as `textForScan` renders it. */
function mapStrings(
  value: unknown,
  map: (text: string) => string,
  within: Set<object> = new Set(),
): unknown {
  if (typeof value === 'string') {
    return map(value);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (within.has(value)) {
    return CIRCULAR;
  }
  within.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => mapStrings(item, map, within));
    }
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = mapStrings(nested, map, within);
    }
    return out;
  } finally {
    within.delete(value);
  }
}

export { mapStrings };
