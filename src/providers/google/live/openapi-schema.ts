/**
 * Gemini Live / OpenAPI Schema 3.0 style type uppercasing for function parameters.
 * JSON Schema uses lowercase `object`/`string`; Gemini Live expects `OBJECT`/`STRING`.
 */

function convertGeminiSchemaType(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return { type: value.toUpperCase() };
  if (!Array.isArray(value)) return { type: toGeminiOpenApiSchema(value) };

  const schemaTypes = value.filter((item): item is string => typeof item === 'string');
  const nonNullTypes = schemaTypes.filter((item) => item !== 'null');
  const converted: Record<string, unknown> = {};
  if (schemaTypes.includes('null')) converted.nullable = true;
  if (nonNullTypes.length === 1) converted.type = nonNullTypes[0]!.toUpperCase();
  if (nonNullTypes.length > 1) {
    converted.anyOf = nonNullTypes.map((item) => ({ type: item.toUpperCase() }));
  }
  return converted;
}

function convertGeminiSchemaObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'type') {
      Object.assign(result, convertGeminiSchemaType(value));
    } else if (key === 'enum' && Array.isArray(value)) {
      result.enum = value.filter((item) => item !== null);
    } else {
      result[key] = toGeminiOpenApiSchema(value);
    }
  }
  return result;
}

/** Convert JSON-Schema-ish parameters to Gemini Live OpenAPI Schema shape. */
export function toGeminiOpenApiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toGeminiOpenApiSchema);
  if (value !== null && typeof value === 'object') {
    return convertGeminiSchemaObject(value as Record<string, unknown>);
  }
  return value;
}
