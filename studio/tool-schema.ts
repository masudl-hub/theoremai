import { type JsonSchema, sampleFromSchema } from '@theoremjs/web/client';
import { type ZodType, z } from 'zod';

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

export type { JsonSchema };

/**
 * A tool's zod schema, read from its JSON Schema exactly as a file Save writes reads it, so a
 * studio run checks a tool's input and output by the same contract the saved code does.
 */
export function zodFromJsonSchema(schema: JsonSchema): ZodType {
  let read = zods.get(schema);
  if (!read) {
    read = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
    zods.set(schema, read);
  }
  return read;
}

// why: A compile reads every tool's schemas for every agent that uses the tool, again on each edit that settles.
/** Each schema object's zod schema, read once. */
const zods = new WeakMap<JsonSchema, ZodType>();
/** Each schema text that parses, by its text: the same text gives the same schema object, so its zod schema is read once too. */
const parsedSchemas = new Map<string, JsonSchema>();
/** Texts kept before the cache starts over: past this, they are mostly drafts typed and gone. */
const MAX_PARSED_SCHEMAS = 1000;

/** Frozen all the way down: a schema shared by every compile that reads its text must not change under one. */
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) frozen(inner);
    Object.freeze(value);
  }
  return value;
}

/** Required fields, and optional ones with an example; the package's form fills a tool's request the same way. */
export function sampleFromJsonSchema(schema: JsonSchema): Record<string, unknown> {
  return sampleFromSchema(schema);
}

/** Characters escaped even inside a string literal, so pasted source can't close a `<script>` or break a line. */
const UNSAFE_SOURCE_CHARS: Record<string, string> = {
  '<': '\\u003C',
  '>': '\\u003E',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

export function quoteSource(text: string): string {
  const body = JSON.stringify(text)
    .slice(1, -1)
    .replaceAll('\\"', '"')
    .replaceAll("'", "\\'")
    .replace(/[<>\u2028\u2029]/g, (char) => UNSAFE_SOURCE_CHARS[char] ?? char);
  return `'${body}'`;
}

/** Bare when the key is an identifier. */
export function keySource(key: string, quote: (text: string) => string = quoteSource): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : quote(key);
}

/** `label` names the schema in the error. */
export function parseJsonSchema(
  raw: string,
  label: string,
): { ok: true; schema: JsonSchema } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: `${label} JSON Schema is required.` };
  const known = parsedSchemas.get(trimmed);
  if (known) return { ok: true, schema: known };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: `${label} JSON Schema must be an object.` };
    }
    // Read here as the saved file reads it, so a schema zod can't read is this field's issue.
    try {
      zodFromJsonSchema(parsed as JsonSchema);
    } catch (err) {
      return { ok: false, error: `${label} JSON Schema can't be read: ${(err as Error).message}.` };
    }
    if (parsedSchemas.size >= MAX_PARSED_SCHEMAS) parsedSchemas.clear();
    const schema = frozen(parsed as JsonSchema);
    parsedSchemas.set(trimmed, schema);
    return { ok: true, schema };
  } catch {
    return { ok: false, error: `${label} JSON Schema is not valid JSON.` };
  }
}
