import { draftKey } from '../../draft.ts';
import { isRecord } from './studio-session.ts';

/** One name and value of a JSON object, as a row of the editor holds it. */
export interface Entry {
  key: string;
  name: string;
  value: string;
}

function readsAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function valueText(value: unknown, typed: boolean): string {
  if (typeof value !== 'string') return JSON.stringify(value);
  return typed && readsAsJson(value) ? JSON.stringify(value) : value;
}

function typedValue(text: string): unknown {
  return readsAsJson(text) ? JSON.parse(text) : text;
}

/**
 * The rows of a JSON object held as text: none while it is not one. With `typed`, a value can be
 * any JSON and plain text is a string, so a string that reads as JSON shows in its quotes.
 */
export function entriesOf(text: string, typed: boolean): Entry[] {
  if (!readsAsJson(text)) return [];
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) return [];
  return Object.entries(parsed).map(([name, value]) => ({
    key: draftKey('entry'),
    name,
    value: valueText(value, typed),
  }));
}

/** The JSON object the named rows make, as text: blank when none is named. */
export function entriesText(entries: readonly Entry[], typed: boolean): string {
  const named = entries.flatMap(({ name, value }) => {
    const trimmed = name.trim();
    return trimmed ? [[trimmed, typed ? typedValue(value) : value]] : [];
  });
  return named.length > 0 ? JSON.stringify(Object.fromEntries(named)) : '';
}
