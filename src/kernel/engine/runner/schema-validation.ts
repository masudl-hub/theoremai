import { TheoremError } from '../../../guardrails/error.ts';
import type {
  ItemCheckTurn,
  ProfileItemRule,
  ProfileValidator,
  ValidationResult,
} from '../../types.ts';

interface ValidationFailure {
  path: string;
  error: string;
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (isAbsent(value) || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asObjectSchema(schema: unknown): Record<string, unknown> | null {
  const rec = asRecord(schema);
  if (!rec) {
    return null;
  }
  if (rec.type !== undefined && rec.type !== 'object') {
    return null;
  }
  return rec;
}

function requiredKeys(schema: Record<string, unknown>): string[] {
  const raw = schema.required;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((k): k is string => typeof k === 'string');
}

function propertySchemas(schema: Record<string, unknown>): Record<string, unknown> {
  const props = schema.properties;
  return asRecord(props) ?? {};
}

function joinPath(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

function pushMissing(path: string, failures: ValidationFailure[]): void {
  failures.push({ path, error: `required field '${path}' is missing` }); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
}

async function runFieldValidator(
  path: string,
  value: unknown,
  validator: ProfileValidator | undefined,
  options: Readonly<Record<string, string>> | undefined,
  failures: ValidationFailure[],
  crashes: unknown[],
): Promise<void> {
  if (!validator) {
    return;
  }
  let check: ValidationResult;
  try {
    check = await validator(value, options);
  } catch (error) {
    // invariant: A check that cannot answer is a no.
    crashes.push(error);
    check = { isValid: false };
  }
  if (check.isValid) {
    return;
  }
  failures.push({
    path,
    error: check.error || check.finding || `Validation failed for '${path}'`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  });
}

async function visitProperty(args: {
  path: string;
  propSchema: unknown;
  child: unknown;
  isRequired: boolean;
  fields: Record<string, ProfileValidator> | undefined;
  options: Readonly<Record<string, string>> | undefined;
  failures: ValidationFailure[];
  crashes: unknown[];
}): Promise<void> {
  const { path, propSchema, child, isRequired, fields, options, failures, crashes } = args;
  if (isAbsent(child)) {
    if (isRequired) {
      pushMissing(path, failures);
    }
    return;
  }

  await runFieldValidator(path, child, fields?.[path], options, failures, crashes);

  const nested = asObjectSchema(propSchema);
  const nestedValue = nested ? asRecord(child) : null;
  if (nested && nestedValue) {
    await walkObject(nested, nestedValue, path, fields, options, failures, crashes);
  }
}

async function walkObject(
  schema: Record<string, unknown>,
  value: unknown,
  pathPrefix: string,
  fields: Record<string, ProfileValidator> | undefined,
  options: Readonly<Record<string, string>> | undefined,
  failures: ValidationFailure[],
  crashes: unknown[],
): Promise<void> {
  const props = propertySchemas(schema);
  const required = new Set(requiredKeys(schema));
  const keys = new Set([...Object.keys(props), ...required]);
  const record = asRecord(value);

  for (const key of keys) {
    await visitProperty({
      path: joinPath(pathPrefix, key),
      propSchema: props[key],
      child: record?.[key],
      isRequired: required.has(key),
      fields,
      options,
      failures,
      crashes,
    });
  }
}

/**
 * Required vs optional comes only from the JSON Schema; host field validators run for required
 * paths and for optional paths that are present. Throws when the root is not an object schema.
 * A validator that throws fails its path, and its error goes into `crashes`.
 */
async function collectValidationFailures(
  jsonSchema: Record<string, unknown>,
  structured: unknown,
  fields: Record<string, ProfileValidator> | undefined,
  options?: Readonly<Record<string, string>>,
  crashes: unknown[] = [],
): Promise<ValidationFailure[]> {
  const root = asObjectSchema(jsonSchema);
  if (!root) {
    throw new TheoremError('config', 'structured validation requires a JSON Schema object root'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const failures: ValidationFailure[] = [];
  if (!asRecord(structured)) {
    for (const key of requiredKeys(root)) {
      pushMissing(key, failures);
    }
    return failures;
  }
  await walkObject(root, structured, '', fields, options, failures, crashes);
  return failures;
}

/**
 * Whether a validator keyed by `path` can run against `jsonSchema`: each segment is a
 * property or required key of an object schema, as `collectValidationFailures` walks it.
 */
function schemaReaches(jsonSchema: Record<string, unknown>, path: string): boolean {
  let schema: unknown = jsonSchema;
  for (const key of path.split('.')) {
    const object = asObjectSchema(schema);
    if (!object) {
      return false;
    }
    const props = propertySchemas(object);
    if (!Object.hasOwn(props, key) && !requiredKeys(object).includes(key)) {
      return false;
    }
    schema = props[key];
  }
  return true;
}

function formatValidationFailures(failures: ValidationFailure[]): string {
  return failures.map((f) => f.error).join('; ');
}

/** One list item an item rule refused: where it sat, the item, and why. */
interface ItemFailure {
  path: string;
  index: number;
  item: unknown;
  reason: string;
  onFail: ProfileItemRule['onFail'];
}

/** The value at a dotted path, reached through object properties only. */
function valueAt(structured: unknown, path: string): unknown {
  let value: unknown = structured;
  for (const key of path.split('.')) {
    value = asRecord(value)?.[key];
  }
  return value;
}

/** `structured` with the list at `path` replaced; every object on the way is copied. */
function withListAt(structured: unknown, path: string, list: unknown[]): unknown {
  const [key, ...rest] = path.split('.');
  const record = asRecord(structured) ?? {};
  if (key === undefined) return structured;
  return {
    ...record,
    [key]: rest.length ? withListAt(record[key], rest.join('.'), list) : list,
  };
}

/**
 * Each item an item rule refuses, in the reply's own order. A path with no list has no items. A
 * check that throws refuses its item, and its error goes into `crashes`.
 */
async function collectItemFailures(
  structured: unknown,
  items: Record<string, ProfileItemRule> | undefined,
  turn: ItemCheckTurn,
  crashes: unknown[] = [],
): Promise<ItemFailure[]> {
  const failures: ItemFailure[] = [];
  for (const [path, rule] of Object.entries(items ?? {})) {
    const list = valueAt(structured, path);
    if (!Array.isArray(list)) continue;
    for (const [index, item] of list.entries()) {
      let check: ValidationResult;
      try {
        check = await rule.check(item, turn);
      } catch (error) {
        crashes.push(error);
        check = { isValid: false };
      }
      if (check.isValid) continue;
      failures.push({
        path,
        index,
        item,
        reason: check.error || check.finding || `Validation failed for '${path}'`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        onFail: rule.onFail,
      });
    }
  }
  return failures;
}

/** The schema of one item of the list at `path`, or `undefined` when the path reaches no list with one. */
function itemSchemaAt(
  jsonSchema: Record<string, unknown>,
  path: string,
): Record<string, unknown> | undefined {
  let schema: unknown = jsonSchema;
  for (const key of path.split('.')) {
    const object = asObjectSchema(schema);
    if (!object) return undefined;
    schema = propertySchemas(object)[key];
  }
  const list = asRecord(schema);
  if (list?.type !== 'array') return undefined;
  return asRecord(list.items) ?? undefined;
}

export type { ItemFailure, ValidationFailure };
export {
  collectItemFailures,
  collectValidationFailures,
  formatValidationFailures,
  isAbsent,
  itemSchemaAt,
  schemaReaches,
  valueAt,
  withListAt,
};
