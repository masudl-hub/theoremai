import { type JsonSchema, sampleFromSchema } from '@theoremjs/react/client';
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
  return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
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
    return { ok: true, schema: parsed as JsonSchema };
  } catch {
    return { ok: false, error: `${label} JSON Schema is not valid JSON.` };
  }
}
