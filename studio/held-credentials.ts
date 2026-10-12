/**
 * A tool's credentials stay with the project. The page gets the tool's URLs and headers with
 * their credentials masked, and a mask it sends back is filled in from what the project holds:
 * the tool it registered for a run, the file's own text for a Save.
 *
 * @module
 */

import { MASK, maskHeaders, maskUrl, unmaskHeaders, unmaskUrl } from '../src/surface/mod.ts';

type Json = Record<string, unknown>;

const URLS = ['endpoint', 'serverUrl'];
/** What a held URL is told as in a refusal: a mask in a URL has no name of its own to give. */
const URL_LABELS: Record<string, string> = { endpoint: 'its endpoint URL', serverUrl: 'its server URL' };

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A tool as the page gets it: the credentials in its URLs and headers masked. */
export function withoutCredentials<T extends object>(tool: T): T {
  const shown = { ...tool } as Json;
  for (const key of URLS) {
    const url = shown[key];
    if (typeof url === 'string') shown[key] = maskUrl(url);
  }
  if (isRecord(shown.headers)) shown.headers = maskHeaders(shown.headers);
  return shown as T;
}

/** One setting of a tool the page sent, each mask in it filled in from `held`, the project's own. */
export function heldSetting(key: string, shown: unknown, held: unknown): unknown {
  if (URLS.includes(key) && typeof shown === 'string') {
    return typeof held === 'string' ? unmaskUrl(shown, held) : shown;
  }
  if (key === 'headers' && isRecord(shown)) {
    return unmaskHeaders(shown as Record<string, string>, isRecord(held) ? (held as Record<string, string>) : undefined);
  }
  return shown;
}

/**
 * The credentials `tool` shows masked that nothing holds a value for: every mask, or with
 * `opened`, the tool as the page got it, the masks that were not there.
 */
export function unheld(tool: object, opened?: object): string[] {
  const [shown, before] = [tool as Json, (opened ?? {}) as Json];
  const names: string[] = [];
  for (const key of URLS) {
    const [url, was] = [shown[key], before[key]];
    if (typeof url !== 'string') continue;
    // A mask the opened URL had is one the project holds; any text stands in for its value here.
    const filled = unmaskUrl(url, typeof was === 'string' ? was.replaceAll(MASK, 'held') : '');
    if (filled.includes(MASK)) names.push(URL_LABELS[key] ?? key);
  }
  const was = isRecord(before.headers) ? before.headers : {};
  for (const [name, value] of Object.entries(isRecord(shown.headers) ? shown.headers : {})) {
    if (value === MASK && was[name] !== MASK) names.push(name);
  }
  return names;
}

/** Why a tool cannot run or be saved, when it shows a credential nothing holds a value for. */
export function unheldProblem(name: string, tool: object, opened?: object): string | undefined {
  const names = unheld(tool, opened);
  return names.length
    ? `${name}: the studio has no value for ${names.join(', ')}. It fills in only what the project's file holds. Write the value there, or put it under Auth.` // labels-exempt: builder diagnostic
    : undefined;
}
