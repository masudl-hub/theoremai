import { isRecord } from '../util/record.ts';

const PLACEHOLDER = /\{\{?([^{}]*)\}\}?/g;
// why: Control and bidi-override characters would let a tool's output restyle or reorder the label.
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/gu;
const INDEX = /^-?\d+$/;
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
// why: Dates show the wall-clock time as the tool wrote it, not converted to the server's zone.
const DAY = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
const DAY_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

const JOINED = /^\+\s+/;
/** The colon that ends a line's condition: the first one followed by a space or the line's end. */
const WHEN_ENDS = /:(?:\s|$)/;
const CHECK = /^(\S+) is (?:(not) )?(\S.*)$/;

/** One line of wording, or a list of lines read top to bottom: the first that fits is shown. */
export type LabelTemplate = string | readonly string[];

type Side = 'input' | 'output';
type Placeholder = { path: string; fallback?: string };
type Route = { side: Side; keys: string[]; prefixed: boolean };
/** `expected: null` is the check "is null". */
type Check = { path: string; negated: boolean; expected: string | null };
type Line = { joined: boolean; when: Check[] | 'unreadable'; text: string };
/** A line on its own, or a run of neighbouring `+` lines that show together. */
type Entry = { joined: boolean; lines: { line: Line; number: number }[] };

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
  return (dateText(text) ?? text) || undefined;
}

function parseChecks(raw: string): Check[] | 'unreadable' {
  const checks: Check[] = [];
  // why: one space between words first, so no pattern below can try a run of spaces two ways.
  for (const part of raw.replace(/\s+/g, ' ').split(' and ')) {
    const match = CHECK.exec(part.trim());
    const [, path, not, expected] = match ?? [];
    if (!path || !expected) return 'unreadable';
    const literal = expected.trim();
    checks.push({ path, negated: Boolean(not), expected: literal === 'null' ? null : literal });
  }
  return checks;
}

/** `+ when status is archived: archiving {name}` is a joined line, with one check, then its text. */
function parseLine(raw: string): Line {
  const joined = JOINED.test(raw);
  const rest = raw.replace(JOINED, '').trim();
  if (!/^when(\s|$)/.test(rest)) return { joined, when: [], text: rest };
  const end = rest.search(WHEN_ENDS);
  if (end < 0) return { joined, when: 'unreadable', text: '' };
  return { joined, when: parseChecks(rest.slice(4, end)), text: rest.slice(end + 1).trim() };
}

function entriesOf(template: LabelTemplate): Entry[] {
  const raw = typeof template === 'string' ? [template] : template;
  const entries: Entry[] = [];
  raw.forEach((text, index) => {
    const line = parseLine(text);
    const last = entries.at(-1);
    if (line.joined && last?.joined) last.lines.push({ line, number: index + 1 });
    else entries.push({ joined: line.joined, lines: [{ line, number: index + 1 }] });
  });
  return entries;
}

/** The input keys a check reads, or `undefined` when it names the output. */
function checkKeys(path: string): string[] | undefined {
  const [route] = routes(path, ['input']);
  return route?.side === 'input' ? route.keys : undefined;
}

// why: "is not" is the plain opposite of "is", so a field the model left out is not any value.
function checkHolds(check: Check, input: unknown): boolean {
  const keys = checkKeys(check.path);
  if (!keys) return false;
  const value = valueAt(input, keys);
  const comparable =
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  const is = check.expected === null ? value === null : comparable && `${value}` === check.expected;
  return is !== check.negated;
}

/** "a", "a and b", "a, b, and c". */
function joinedInWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')}${parts.length > 2 ? ',' : ''} and ${parts.at(-1)}`;
}

/** A tool's name as a label shows it: `manage_alert` reads "manage alert". */
export function toolNameInWords(name: string): string {
  return name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
}

function fillText(
  template: string,
  values: { input: unknown; output?: unknown },
  sides: readonly Side[],
): string | undefined {
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

/**
 * Fills each `{path}` or `{path|fallback}` from the call. Only text and numbers fill; a line fits
 * when every placeholder has a value or a fallback and its `when` holds. A list shows its first
 * line that fits, and a run of `+` lines shows every member that fits, joined in words. When no
 * line fits the label is `undefined`, and the transcript names the tool.
 */
export function fillActivityLabel(
  template: LabelTemplate | undefined,
  values: { input: unknown; output?: unknown },
): string | undefined {
  if (template === undefined) return undefined;
  const sides: Side[] = 'output' in values ? ['input', 'output'] : ['input'];
  for (const entry of entriesOf(template)) {
    const fitting = entry.lines.flatMap(({ line }) => {
      if (line.when === 'unreadable') return [];
      if (!line.when.every((check) => checkHolds(check, values.input))) return [];
      const text = fillText(line.text, values, sides);
      return text === undefined ? [] : [text];
    });
    if (fitting.length) return joinedInWords(fitting);
  }
  return undefined;
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
  // why: A list's length is a number a label can show, after its first item's fields.
  if (schemaTypes(node).includes('array')) return [...leavesAt(node.items, at('0')), at('length')];
  if (!isRecord(node.properties)) return [];
  return Object.entries(node.properties).flatMap(([key, child]) => leavesAt(child, at(key)));
}

function leavesAt(node: unknown, path: string): string[] {
  if (!isRecord(node) || '$ref' in node) return [path];
  const types = schemaTypes(node);
  if (types.length && types.every((type) => type === 'boolean')) return [];
  const branches = schemaBranches(node);
  // why: A branch of text or null (a nullable field) is still one value a label can show.
  const nested = branches.some((branch) =>
    schemaTypes(branch).some((type) => type === 'array' || type === 'object'),
  );
  const group = types.includes('array') || types.includes('object') || nested;
  if (!group && branches.length) {
    return branches.every((branch) => schemaTypes(branch).every((type) => type === 'boolean'))
      ? []
      : [path];
  }
  return group ? placeholdersAt(node, path) : [path];
}

// why: A schema that doesn't say what's there ($ref, no properties, no items) is taken on trust.
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
    shown.length === 1
      ? shown[0]
      : `${shown.slice(0, -1).join(', ')}${shown.length > 2 ? ',' : ''} or ${shown.at(-1)}`;
  return ` Try ${list}.`;
}

function placeholderProblem(
  template: string,
  schemas: { input: unknown; output?: unknown },
  sides: readonly Side[],
): string | undefined {
  for (const match of template.matchAll(PLACEHOLDER)) {
    const { path } = parsePlaceholder(match[1] ?? '');
    if (!path) {
      const example = placeholdersAt(schemas.input, '')[0] ?? 'name';
      return `Put a field name between the braces, like {${example}}.`; // labels-exempt: builder diagnostic
    }
    const paths = routes(path, sides);
    const [route] = paths;
    if (!route) continue;
    if (route.prefixed && !sides.includes(route.side)) {
      return `{${path}} is only there once the call is done; use it in the Done label.`; // labels-exempt: builder diagnostic
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
      missing: `is not a field of this tool's ${from}.`, // labels-exempt: builder diagnostic
      group: 'is a list or group; a label shows text or a number.', // labels-exempt: builder diagnostic
      flag: 'is true or false; a label shows text or a number.', // labels-exempt: builder diagnostic
    }[found.holds];
    // why: What the builder ended the path with (a length, a name) says which of the fields they meant.
    const last = route.keys.at(-1);
    const tail = (candidate: string) => (candidate.split('.').at(-1) === last ? 0 : 1);
    // why: Not `toSorted`: the studio's declaration build targets a lib before ES2023.
    const ranked = [...(near.length ? near : all)].sort((a, b) => tail(a) - tail(b));
    return `{${path}} ${reason}${tryInstead(ranked)}`;
  }
  return undefined;
}

type Leaf = { texts: string[] | 'any'; nullable: boolean };

const OPEN_LEAF: Leaf = { texts: 'any', nullable: true };

function rawTypes(node: Record<string, unknown>): string[] {
  const types = Array.isArray(node.type) ? node.type : [node.type];
  return types.filter((type): type is string => typeof type === 'string');
}

function leafOf(node: Record<string, unknown>): Leaf {
  const listed = Array.isArray(node.enum) ? node.enum : 'const' in node ? [node.const] : undefined;
  if (listed) {
    return {
      texts: listed.filter((value) => value !== null).map((value) => `${value}`),
      nullable: listed.includes(null),
    };
  }
  const types = rawTypes(node);
  if (types.length === 0) return OPEN_LEAF;
  const shown = types.filter((type) => type !== 'null');
  const flag = shown.every((type) => type === 'boolean');
  return {
    texts: flag ? (shown.length ? ['true', 'false'] : []) : 'any',
    nullable: types.includes('null'),
  };
}

// why: A schema that doesn't say what's there ($ref, no properties, no items) is taken on trust.
function schemaLeavesAt(node: unknown, keys: readonly string[]): Leaf[] {
  if (!isRecord(node) || '$ref' in node) return [OPEN_LEAF];
  const branches = schemaBranches(node);
  if (branches.length) return branches.flatMap((branch) => schemaLeavesAt(branch, keys));
  const [key, ...rest] = keys;
  if (key === undefined) return [leafOf(node)];
  const types = schemaTypes(node);
  if (types.includes('array')) {
    if (key === 'length') return rest.length ? [] : [{ texts: 'any', nullable: false }];
    if (INDEX.test(key)) return schemaLeavesAt(node.items, rest);
  }
  if (isRecord(node.properties)) {
    return Object.hasOwn(node.properties, key) ? schemaLeavesAt(node.properties[key], rest) : [];
  }
  return types.length === 0 && rawTypes(node).length === 0 ? [OPEN_LEAF] : [];
}

/** The input's own field names, flags included: what a `when` can compare. */
function inputFields(node: unknown): string[] {
  if (!isRecord(node)) return [];
  const branches = schemaBranches(node).flatMap(inputFields);
  const own = isRecord(node.properties) ? Object.keys(node.properties) : [];
  return [...new Set([...own, ...branches])];
}

function oneOf(values: readonly string[]): string {
  const shown = [...new Set(values)].map((value) => `"${value}"`);
  return shown.length <= 1
    ? (shown[0] ?? '')
    : `${shown.slice(0, -1).join(', ')}${shown.length > 2 ? ',' : ''} or ${shown.at(-1)}`;
}

function checkProblem(check: Check, input: unknown): string | undefined {
  const keys = checkKeys(check.path);
  if (!keys) {
    return `A "when" reads what the model sent; "${check.path}" is only there once the call is done.`; // labels-exempt: builder diagnostic
  }
  const found = schemaPathHolds(input, keys, '');
  if (found.holds === 'missing') {
    const fields = inputFields(input).slice(0, 4);
    const tryThese = fields.length ? ` Try ${oneOf(fields)}.` : ''; // labels-exempt: builder diagnostic
    return `"${check.path}" in the "when" is not a field of this tool's input.${tryThese}`; // labels-exempt: builder diagnostic
  }
  if (found.holds === 'group') {
    return `"${check.path}" in the "when" is a list or group; a "when" compares text, a number, or true or false.`; // labels-exempt: builder diagnostic
  }
  const leaves = schemaLeavesAt(input, keys);
  if (check.expected === null) {
    return leaves.some((leaf) => leaf.nullable) ? undefined : `"${check.path}" is never null.`; // labels-exempt: builder diagnostic
  }
  const texts: string[] = [];
  for (const leaf of leaves) {
    if (leaf.texts === 'any') return undefined;
    texts.push(...leaf.texts);
  }
  if (texts.includes(check.expected)) return undefined;
  const itIs = texts.length ? ` It is ${oneOf(texts)}.` : ''; // labels-exempt: builder diagnostic
  return `"${check.path}" is never "${check.expected}".${itIs}`; // labels-exempt: builder diagnostic
}

function lineProblem(
  line: Line,
  schemas: { input: unknown; output?: unknown },
  sides: readonly Side[],
  mustShow: boolean,
): string | undefined {
  if (line.when === 'unreadable') {
    return 'A line that opens with "when" needs a condition and a colon, like "when status is archived: archiving {name}". A condition uses "is", "is not", "is null", and "and".'; // labels-exempt: builder diagnostic
  }
  for (const check of line.when) {
    const problem = checkProblem(check, schemas.input);
    if (problem) return problem;
  }
  if (!line.text && (mustShow || line.when.length)) {
    return 'It has no wording to show.'; // labels-exempt: builder diagnostic
  }
  return placeholderProblem(line.text, schemas, sides);
}

/** Whether a line shows for every call: no `when`, and a fallback on every placeholder. */
function alwaysFits(line: Line): boolean {
  if (line.when === 'unreadable' || line.when.length) return false;
  let open = false;
  const settled = line.text.replace(PLACEHOLDER, (_, raw: string) => {
    const { fallback } = parsePlaceholder(raw);
    if (fallback === undefined) open = true;
    return fallback ?? '';
  });
  return !open && settled.trim().length > 0;
}

function listProblem(entries: readonly Entry[]): string | undefined {
  const fits = entries.map((entry) => entry.lines.some(({ line }) => alwaysFits(line)));
  const early = fits.slice(0, -1).indexOf(true);
  if (early >= 0) {
    const number = entries[early]?.lines.find(({ line }) => alwaysFits(line))?.number;
    return `Line ${number} always fits, so the lines below it are never read. Move it to the end.`; // labels-exempt: builder diagnostic
  }
  if (fits.at(-1)) return undefined;
  return 'The last line must always fit, so every call gets a label: no "when", and a fallback on every {value}, like "saving the item".'; // labels-exempt: builder diagnostic
}

/**
 * Why a label can't be used with these JSON schemas, as a sentence for its author, or `undefined`
 * when it can. Pass `output` for a Done label. A list must end on a line that always fits.
 */
export function activityLabelProblem(
  template: LabelTemplate,
  schemas: { input: unknown; output?: unknown },
): string | undefined {
  const sides: Side[] = 'output' in schemas ? ['input', 'output'] : ['input'];
  const listed = typeof template !== 'string';
  const entries = entriesOf(template);
  for (const { line, number } of entries.flatMap((entry) => entry.lines)) {
    const problem = lineProblem(line, schemas, sides, listed);
    if (problem) return listed ? `Line ${number}: ${problem}` : problem; // labels-exempt: builder diagnostic
  }
  return listed ? listProblem(entries) : undefined;
}
