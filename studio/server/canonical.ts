/**
 * Values compared as text. On its own so the project's load, which reads no
 * source, does not load the TypeScript the Save plan reads source with.
 *
 * @module
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `value` with every object's keys in order and nothing undefined, as text: equal values give equal text. */
export function canonical(value: unknown): string {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered);
    if (!isRecord(item)) return item;
    const keys = Object.keys(item).filter((key) => item[key] !== undefined).sort();
    return Object.fromEntries(keys.map((key) => [key, ordered(item[key])]));
  };
  return JSON.stringify(ordered(value)) ?? 'undefined';
}
