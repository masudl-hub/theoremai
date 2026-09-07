/**
 * Tool JSON Schema validation and Zod → wire schema conversion.
 *
 * @module
 */

import { type ZodType, z } from 'zod';
import { TheorumError } from '../../guardrails/error.ts';

const GEMINI_SUPPORTED_SCHEMA_KEYS = [
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'default',
  'example',
  'items',
  'minItems',
  'maxItems',
  'properties',
  'required',
  'propertyOrdering',
  'minProperties',
  'maxProperties',
  'minimum',
  'maximum',
  'pattern',
  'minLength',
  'maxLength',
  'anyOf',
  'oneOf',
] as const;

export type JsonSchema = Record<string, unknown>;

function validateGeminiKeys(schema: JsonSchema, path: string, errors: string[]): void {
  for (const key of Object.keys(schema)) {
    if (!(GEMINI_SUPPORTED_SCHEMA_KEYS as readonly string[]).includes(key)) {
      errors.push(`${path}: unsupported Gemini schema key '${key}'`);
    }
  }
}

function validateSchemaShape(
  schema: JsonSchema,
  path: string,
  mode: 'gemini' | 'structural',
  errors: string[],
): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    errors.push(`${path}: schema must be an object`);
    return false;
  }
  const hasType = typeof schema.type === 'string' || Array.isArray(schema.type);
  const hasCombinator = schema.anyOf !== undefined || schema.oneOf !== undefined;
  if (!hasType && !hasCombinator) {
    if (mode === 'structural' && path !== '$') {
      return true;
    }
    errors.push(`${path}: missing type or combinator`);
  }
  if (mode === 'gemini') {
    validateGeminiKeys(schema, path, errors);
  }
  if (schema.type === 'array' && schema.items === undefined) {
    errors.push(`${path}: array schema must define items`);
  }
  return true;
}

function walkSchemaProperties(
  props: Record<string, unknown>,
  required: unknown,
  path: string,
  mode: 'gemini' | 'structural',
  errors: string[],
): void {
  const reqList = Array.isArray(required) ? required : [];
  for (const req of reqList) {
    if (typeof req === 'string' && !(req in props)) {
      errors.push(`${path}: required key '${req}' missing from properties`);
    }
  }
  for (const [key, child] of Object.entries(props)) {
    if (child && typeof child === 'object') {
      walkSchema(child as JsonSchema, `${path}.properties.${key}`, mode, errors);
    }
  }
}

function walkSchema(
  schema: JsonSchema,
  path: string,
  mode: 'gemini' | 'structural',
  errors: string[],
): void {
  if (!validateSchemaShape(schema, path, mode, errors)) return;

  const props = schema.properties;
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    walkSchemaProperties(props as Record<string, unknown>, schema.required, path, mode, errors);
  }
  if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    walkSchema(schema.items as JsonSchema, `${path}.items`, mode, errors);
  }
  for (const combinator of ['anyOf', 'oneOf'] as const) {
    const branch = schema[combinator];
    if (Array.isArray(branch)) {
      branch.forEach((entry, index) => {
        if (entry && typeof entry === 'object') {
          walkSchema(entry as JsonSchema, `${path}.${combinator}[${index}]`, mode, errors);
        }
      });
    }
  }
}

/** Validate a tool wire schema for provider compatibility. */
function validateToolWireSchema(
  schema: JsonSchema,
  mode: 'gemini' | 'structural' = 'gemini',
  label = 'input',
): void {
  const errors: string[] = [];
  walkSchema(schema, '$', mode, errors);
  if (errors.length > 0) {
    throw new TheorumError(`Invalid tool ${label} schema: ${errors.join('; ')}`);
  }
}

/** Validate a tool parameter schema for provider compatibility. */
function validateToolInputSchema(
  schema: JsonSchema,
  mode: 'gemini' | 'structural' = 'gemini',
): void {
  validateToolWireSchema(schema, mode, 'input');
}

/** Validate a tool result schema at registration. */
function validateToolOutputSchema(
  schema: JsonSchema,
  mode: 'gemini' | 'structural' = 'structural',
): void {
  validateToolWireSchema(schema, mode, 'output');
}

function stripProperties(value: unknown): JsonSchema {
  const props: JsonSchema = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [propKey, propValue] of Object.entries(value as JsonSchema)) {
      if (propValue && typeof propValue === 'object') {
        props[propKey] = stripUnsupportedGeminiKeys(propValue as JsonSchema);
      }
    }
  }
  return props;
}

function stripBranches(branches: unknown[]): unknown[] {
  return branches.map((entry) =>
    entry && typeof entry === 'object' ? stripUnsupportedGeminiKeys(entry as JsonSchema) : entry,
  );
}

/** Derive provider wire JSON Schema from a Zod type. */
function stripUnsupportedGeminiKeys(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!(GEMINI_SUPPORTED_SCHEMA_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    if (key === 'properties') {
      out.properties = stripProperties(value);
      continue;
    }
    if (key === 'items' && value && typeof value === 'object' && !Array.isArray(value)) {
      out.items = stripUnsupportedGeminiKeys(value as JsonSchema);
      continue;
    }
    if ((key === 'anyOf' || key === 'oneOf') && Array.isArray(value)) {
      out[key] = stripBranches(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function jsonSchemaFromZod(schema: ZodType, io: 'input' | 'output' = 'output'): JsonSchema {
  const json = z.toJSONSchema(schema, {
    target: 'openApi3',
    io,
  }) as JsonSchema;
  delete json.$schema;
  if (!json.type) {
    json.type = 'object';
  }
  return stripUnsupportedGeminiKeys(json);
}

export { jsonSchemaFromZod, validateToolInputSchema, validateToolOutputSchema };
