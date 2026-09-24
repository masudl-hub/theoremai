/**
 * Tool schemas as the playground authors them: JSON Schema text, turned into Zod
 * for registration and into `z.looseObject(...)` source for export. Covers the
 * subset the editor writes — objects, arrays, and primitives.
 *
 * @module
 */

import { z, type ZodType } from 'zod';

export const DEFAULT_TOOL_INPUT_SCHEMA = `{
  "type": "object",
  "properties": {
    "query": { "type": "string" }
  },
  "required": ["query"]
}`;

export const DEFAULT_TOOL_OUTPUT_SCHEMA = `{
  "type": "object",
  "properties": {
    "result": { "type": "string" }
  },
  "required": ["result"]
}`;

/** A JSON Schema object as authored. */
export type JsonSchema = Record<string, unknown>;

function schemaFields(schema: JsonSchema): {
  props: Record<string, JsonSchema>;
  required: Set<string>;
} {
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : [],
  );
  return { props, required };
}

type SchemaKind = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'unknown';

function schemaKind(prop: JsonSchema): SchemaKind {
  const t = prop.type;
  if (t === 'string' || (Array.isArray(t) && t.includes('string'))) return 'string';
  if (t === 'number' || t === 'integer') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'array') return 'array';
  if (t === 'object' || prop.properties) return 'object';
  return 'unknown';
}

function arrayItems(prop: JsonSchema): JsonSchema | undefined {
  const items = prop.items;
  return items && typeof items === 'object' && !Array.isArray(items)
    ? (items as JsonSchema)
    : undefined;
}

function propToZod(prop: JsonSchema): ZodType {
  switch (schemaKind(prop)) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array': {
      const items = arrayItems(prop);
      return z.array(items ? propToZod(items) : z.unknown());
    }
    case 'object':
      return zodFromJsonSchema(prop);
    case 'unknown':
      return z.unknown();
  }
}

/** A Zod schema for a JSON Schema object (or array) the playground authored. */
export function zodFromJsonSchema(schema: JsonSchema): ZodType {
  if (schema.type === 'array') return propToZod(schema);
  const { props, required } = schemaFields(schema);
  const shape: Record<string, ZodType> = {};
  for (const [key, prop] of Object.entries(props)) {
    const field = propToZod(prop);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return z.looseObject(shape);
}

/** A single-quoted TypeScript string literal. */
export function quoteSource(text: string): string {
  return `'${JSON.stringify(text).slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'")}'`;
}

/** An object key as TypeScript source: bare when it is an identifier. */
export function keySource(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : quoteSource(key);
}

function zodExprFromProp(prop: JsonSchema, depth: number): string {
  switch (schemaKind(prop)) {
    case 'string':
      return 'z.string()';
    case 'number':
      return 'z.number()';
    case 'boolean':
      return 'z.boolean()';
    case 'array': {
      const items = arrayItems(prop);
      return `z.array(${items ? zodExprFromProp(items, depth) : 'z.unknown()'})`;
    }
    case 'object':
      return zodExprFromJsonSchema(prop, depth);
    case 'unknown':
      return 'z.unknown()';
  }
}

/**
 * Source for the Zod schema `zodFromJsonSchema` builds, for the exported module.
 * `depth` is the indent level the expression starts at.
 */
export function zodExprFromJsonSchema(schema: JsonSchema, depth = 0): string {
  if (schema.type === 'array') return zodExprFromProp(schema, depth);
  const { props, required } = schemaFields(schema);
  const entries = Object.entries(props);
  if (!entries.length) return 'z.looseObject({})';
  const pad = '  '.repeat(depth + 1);
  const lines = entries.map(([key, prop]) => {
    const expr = zodExprFromProp(prop, depth + 1);
    return `${pad}${keySource(key)}: ${required.has(key) ? expr : `${expr}.optional()`},`;
  });
  return `z.looseObject({\n${lines.join('\n')}\n${'  '.repeat(depth)}})`;
}

/** Parse authored JSON Schema text; `label` names it in the error. */
export function parseJsonSchema(
  raw: string,
  label: string,
): { ok: true; schema: JsonSchema } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: `${label} JSON Schema is required.` };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: `${label} JSON Schema must be an object.` };
    }
    return { ok: true, schema: parsed as JsonSchema };
  } catch {
    return { ok: false, error: `${label} JSON Schema is not valid JSON.` };
  }
}
