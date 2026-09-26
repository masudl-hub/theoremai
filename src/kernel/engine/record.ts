import { isRecord } from '../util/record.ts';

/** The value as a record when it is one (`isRecord`); otherwise undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** The string when it has non-whitespace content; otherwise undefined. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  return undefined;
}

export { asRecord, nonEmptyString };
