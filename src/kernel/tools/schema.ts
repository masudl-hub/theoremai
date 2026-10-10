import { type ZodType, z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';

export type JsonSchema = Record<string, unknown>;

function validateSchemaShape(schema: JsonSchema, path: string, errors: string[]): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    errors.push(`${path}: schema must be an object`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return false;
  }
  const hasType = typeof schema.type === 'string' || Array.isArray(schema.type);
  const hasCombinator = schema.anyOf !== undefined || schema.oneOf !== undefined;
  if (!hasType && !hasCombinator) {
    if (path !== '$') {
      return true;
    }
    errors.push(`${path}: missing type or combinator`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (schema.type === 'array' && schema.items === undefined) {
    errors.push(`${path}: array schema must define items`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return true;
}

function walkSchemaProperties(
  props: Record<string, unknown>,
  required: unknown,
  path: string,
  errors: string[],
): void {
  const reqList = Array.isArray(required) ? required : [];
  for (const req of reqList) {
    if (typeof req === 'string' && !Object.hasOwn(props, req)) {
      errors.push(`${path}: required key '${req}' missing from properties`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
  }
  for (const [key, child] of Object.entries(props)) {
    if (child && typeof child === 'object') {
      walkSchema(child as JsonSchema, `${path}.properties.${key}`, errors);
    }
  }
}

function walkSchema(schema: JsonSchema, path: string, errors: string[]): void {
  if (!validateSchemaShape(schema, path, errors)) return;

  const props = schema.properties;
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    walkSchemaProperties(props as Record<string, unknown>, schema.required, path, errors);
  }
  if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    walkSchema(schema.items as JsonSchema, `${path}.items`, errors);
  }
  for (const combinator of ['anyOf', 'oneOf'] as const) {
    const branch = schema[combinator];
    if (Array.isArray(branch)) {
      branch.forEach((entry, index) => {
        if (entry && typeof entry === 'object') {
          walkSchema(entry as JsonSchema, `${path}.${combinator}[${index}]`, errors);
        }
      });
    }
  }
}

/** A structural check only: what a provider accepts is its own API's answer. */
function validateToolSchema(schema: JsonSchema, label: 'input' | 'output'): void {
  const errors: string[] = [];
  walkSchema(schema, '$', errors);
  if (errors.length > 0) {
    throw new TheoremError('config', `Invalid tool ${label} schema: ${errors.join('; ')}`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

function jsonSchemaFromZod(schema: ZodType, io: 'input' | 'output' = 'output'): JsonSchema {
  const json = z.toJSONSchema(schema, { target: 'draft-7', io }) as JsonSchema;
  delete json.$schema;
  if (!json.type) {
    json.type = 'object';
  }
  return json;
}

export { jsonSchemaFromZod, validateToolSchema };

/** Strips prototype-pollution keys before validation. */
export function plainToolInput(input: unknown): unknown {
  if (input === null || typeof input !== 'object') {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map(plainToolInput);
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    out[key] = plainToolInput((input as Record<string, unknown>)[key]);
  }
  return out;
}

/** A placeholder in the scheme or authority would let tool input choose where the credential goes. */
export function assertFixedEndpointOrigin(endpoint: string): void {
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(endpoint)?.[0];
  if (!origin || /[{}]/.test(origin)) {
    throw new TheoremError(
      'config',
      `Endpoint "${endpoint}" must start with a fixed scheme and host; placeholders belong in the path or query`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}
