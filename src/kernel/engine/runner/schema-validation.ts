/**
 * Schema-driven structured-output validation.
 *
 * Required vs optional comes only from the JSON Schema. Host field validators
 * run for required paths and for optional paths that are present.
 *
 * @module
 */

import { TheoremError } from '../../../guardrails/error.ts';
import type { ProfileValidator, ValidationResult } from '../../types.ts';

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
  failures.push({ path, error: `required field '${path}' is missing` }); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
}

async function runFieldValidator(
  path: string,
  value: unknown,
  validator: ProfileValidator | undefined,
  slots: Record<string, string> | undefined,
  failures: ValidationFailure[],
): Promise<void> {
  if (!validator) {
    return;
  }
  const check: ValidationResult = await validator(value, slots);
  if (check.isValid) {
    return;
  }
  failures.push({
    path,
    error: check.error || check.finding || `Validation failed for '${path}'`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  });
}

async function visitProperty(args: {
  path: string;
  propSchema: unknown;
  child: unknown;
  isRequired: boolean;
  fields: Record<string, ProfileValidator> | undefined;
  slots: Record<string, string> | undefined;
  failures: ValidationFailure[];
}): Promise<void> {
  const { path, propSchema, child, isRequired, fields, slots, failures } = args;
  if (isAbsent(child)) {
    if (isRequired) {
      pushMissing(path, failures);
    }
    return;
  }

  await runFieldValidator(path, child, fields?.[path], slots, failures);

  const nested = asObjectSchema(propSchema);
  const nestedValue = nested ? asRecord(child) : null;
  if (nested && nestedValue) {
    await walkObject(nested, nestedValue, path, fields, slots, failures);
  }
}

async function walkObject(
  schema: Record<string, unknown>,
  value: unknown,
  pathPrefix: string,
  fields: Record<string, ProfileValidator> | undefined,
  slots: Record<string, string> | undefined,
  failures: ValidationFailure[],
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
      slots,
      failures,
    });
  }
}

/**
 * Collect schema presence failures and host field-validator failures.
 * Throws when the root schema is not an object schema.
 */
async function collectValidationFailures(
  jsonSchema: Record<string, unknown>,
  structured: unknown,
  fields: Record<string, ProfileValidator> | undefined,
  slots?: Record<string, string>,
): Promise<ValidationFailure[]> {
  const root = asObjectSchema(jsonSchema);
  if (!root) {
    throw new TheoremError('structured validation requires a JSON Schema object root'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const failures: ValidationFailure[] = [];
  if (!asRecord(structured)) {
    for (const key of requiredKeys(root)) {
      pushMissing(key, failures);
    }
    return failures;
  }
  await walkObject(root, structured, '', fields, slots, failures);
  return failures;
}

function formatValidationFailures(failures: ValidationFailure[]): string {
  return failures.map((f) => f.error).join('; ');
}

export type { ValidationFailure };
export { collectValidationFailures, formatValidationFailures, isAbsent };
