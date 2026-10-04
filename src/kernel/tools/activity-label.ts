import { isRecord } from '../util/record.ts';

const MAX_VALUE_CHARS = 40;
const PLACEHOLDER = /\{\{?([^{}]*)\}\}?/g;
// Control and bidi-override characters would let a tool's output restyle or reorder the label.
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/gu;
const INDEX = /^-?\d+$/;
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
// Dates show the wall-clock time as the tool wrote it, not converted to the server's zone.
const DAY = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
const DAY_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

type Side = 'input' | 'output';
type Placeholder = { path: string; fallback?: string };
type Route = { side: Side; keys: string[]; prefixed: boolean };

function parsePlaceholder(raw: string): Placeholder {
  const bar = raw.indexOf('|');
  if (bar < 0) return { path: raw.trim() };
  return { path: raw.slice(0, bar).trim(), fallback: raw.slice(bar + 1).trim() };
}

/** `input.x` and `output.x` read one side; a bare path reads the input, then the output. */
function routes(path: string, sides: readonly Side[]): Route[] {
  const keys = path.split('.');
  const [head, ...rest] = keys;
  if ((head === 'input' || head === 'output') && rest.length) {
    return [{ side: head, keys: rest, prefixed: true }];
  }
  return sides.map((side) => ({ side, keys, prefixed: false }));
}

function valueAt(source: unknown, keys: readonly string[]): unknown {
  let value = source;
  for (const key of keys) {
    if (Array.isArray(value)) {
      if (key === 'length') value = value.length;
      else if (INDEX.test(key)) value = value.at(Number(key));
      else return undefined;
    } else if (isRecord(value) && Object.hasOwn(value, key)) value = value[key];
    else return undefined;
  }
  return value;
}

function dateText(text: string): string | undefined {
  const match = ISO_DATE.exec(text);
  if (!match) return undefined;
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0] = match
    .slice(1)
    .map((part) => Number(part ?? 0));
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (Number.isNaN(at.getTime()) || at.getUTCDate() !== day) return undefined;
  return (match[4] === undefined ? DAY : DAY_TIME).format(at);
}

function labelValue(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? NUMBER.format(value) : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.replace(UNPRINTABLE, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...(dateText(text) ?? text)];
  if (chars.length === 0) return undefined;
  if (chars.length <= MAX_VALUE_CHARS) return chars.join('');
  const head = chars.slice(0, MAX_VALUE_CHARS - 1).join('');
  return `${head.trimEnd()}…`;
}

/**
 * Fills each `{path}` or `{path|fallback}` from the call. Only text and numbers fill; a placeholder
 * with no value and no fallback leaves the whole label `undefined`, and the transcript names the tool.
 */
export function fillActivityLabel(
  template: string | undefined,
  values: { input: unknown; output?: unknown },
): string | undefined {
  if (!template?.trim()) return undefined;
  const sides: Side[] = 'output' in values ? ['input', 'output'] : ['input'];
  let missing = false;
  const filled = template.replace(PLACEHOLDER, (_, raw: string) => {
    const { path, fallback } = parsePlaceholder(raw);
    const value = path
      ? routes(path, sides)
          .map((route) => labelValue(valueAt(values[route.side], route.keys)))
          .find((text) => text !== undefined)
      : undefined;
    if (value === undefined && fallback === undefined) missing = true;
    return value ?? fallback ?? '';
  });
  const text = filled.replace(/\s+/g, ' ').trim();
  return missing || !text ? undefined : text;
}

type Holds = { holds: 'value' | 'group' | 'flag' | 'missing'; instead?: string[] };

const HOLDS_RANK = ['value', 'group', 'flag', 'missing'] as const;

function schemaTypes(node: Record<string, unknown>): string[] {
  const types = Array.isArray(node.type) ? node.type : [node.type];
  return types.filter((type): type is string => typeof type === 'string' && type !== 'null');
}

function schemaBranches(node: Record<string, unknown>): Record<string, unknown>[] {
  return [node.anyOf, node.oneOf, node.allOf].flatMap((list) =>
    Array.isArray(list) ? list.filter(isRecord) : [],
  );
}

function mergeHolds(found: readonly Holds[]): Holds {
  const holds = HOLDS_RANK.find((rank) => found.some((entry) => entry.holds === rank)) ?? 'missing';
  const same = found.filter((entry) => entry.holds === holds);
  return { holds, instead: same.flatMap((entry) => entry.instead ?? []) };
}

/** The paths under `node` a label can show, for suggestions. */
function placeholdersAt(node: unknown, prefix: string): string[] {
  const at = (key: string) => (prefix ? `${prefix}.${key}` : key);
  if (!isRecord(node)) return [];
  const branches = schemaBranches(node);
  if (branches.length) return branches.flatMap((branch) => placeholdersAt(branch, prefix));
  if (schemaTypes(node).includes('array')) return leavesAt(node.items, at('0'));
  if (!isRecord(node.properties)) return [];
  return Object.entries(node.properties).flatMap(([key, child]) => leavesAt(child, at(key)));
}

function leavesAt(node: unknown, path: string): string[] {
  if (!isRecord(node) || '$ref' in node) return [path];
  const types = schemaTypes(node);
  if (types.length && types.every((type) => type === 'boolean')) return [];
  const group = types.includes('array') || types.includes('object') || schemaBranches(node).length;
  return group ? placeholdersAt(node, path) : [path];
}

// A schema that doesn't say what's there ($ref, no properties, no items) is taken on trust.
function schemaPathHolds(node: unknown, keys: readonly string[], walked: string): Holds {
  if (!isRecord(node) || '$ref' in node) return { holds: 'value' };
  const branches = schemaBranches(node);
  if (branches.length) {
    return mergeHolds(branches.map((branch) => schemaPathHolds(branch, keys, walked)));
  }
  const types = schemaTypes(node);
  const [key, ...rest] = keys;
  if (key === undefined) {
    if (types.length && types.every((type) => type === 'boolean')) return { holds: 'flag' };
    if (types.includes('array') || types.includes('object')) {
      return { holds: 'group', instead: placeholdersAt(node, walked) };
    }
    return { holds: 'value' };
  }
  const next = walked ? `${walked}.${key}` : key;
  const missing: Holds = { holds: 'missing', instead: placeholdersAt(node, walked) };
  if (types.includes('array')) {
    if (key === 'length') return rest.length ? missing : { holds: 'value' };
    if (INDEX.test(key)) {
      return isRecord(node.items) ? schemaPathHolds(node.items, rest, next) : { holds: 'value' };
    }
  }
  if (isRecord(node.properties)) {
    return Object.hasOwn(node.properties, key)
      ? schemaPathHolds(node.properties[key], rest, next)
      : missing;
  }
  return types.length === 0 || types.includes('object') ? { holds: 'value' } : missing;
}

function tryInstead(paths: readonly string[]): string {
  const shown = [...new Set(paths)].slice(0, 4).map((path) => `{${path}}`);
  if (shown.length === 0) return '';
  const list =
    shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} or ${shown.at(-1)}`;
  return ` Try ${list}.`;
}

/**
 * Why a label can't fill from these JSON schemas, as a sentence for its author, or `undefined`
 * when every placeholder can. Pass `output` for a Done label.
 */
export function activityLabelProblem(
  template: string,
  schemas: { input: unknown; output?: unknown },
): string | undefined {
  const sides: Side[] = 'output' in schemas ? ['input', 'output'] : ['input'];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const { path } = parsePlaceholder(match[1] ?? '');
    if (!path) {
      const example = placeholdersAt(schemas.input, '')[0] ?? 'name';
      return `Put a field name between the braces, like {${example}}.`; // lexicon-exempt: builder diagnostic
    }
    const paths = routes(path, sides);
    const [route] = paths;
    if (!route) continue;
    if (route.prefixed && !sides.includes(route.side)) {
      return `{${path}} is only there once the call is done; use it in the Done label.`; // lexicon-exempt: builder diagnostic
    }
    const found = mergeHolds(
      paths.map(({ side, keys, prefixed }) =>
        schemaPathHolds(schemas[side], keys, prefixed ? side : ''),
      ),
    );
    if (found.holds === 'value') continue;
    const all = found.instead ?? [];
    const depth = route.prefixed ? 1 : 0;
    const near = all.filter((candidate) => candidate.split('.')[depth] === route.keys[0]);
    const from = route.prefixed ? route.side : sides.join(' or ');
    const reason = {
      missing: `is not a field of this tool's ${from}.`, // lexicon-exempt: builder diagnostic
      group: 'is a list or group; a label shows text or a number.', // lexicon-exempt: builder diagnostic
      flag: 'is true or false; a label shows text or a number.', // lexicon-exempt: builder diagnostic
    }[found.holds];
    return `{${path}} ${reason}${tryInstead(near.length ? near : all)}`;
  }
  return undefined;
}
