/**
 * The one check for "is this a plain object" on untrusted values.
 *
 * @module
 */

/** An object that is not null and not an array: JSON's `{…}`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
