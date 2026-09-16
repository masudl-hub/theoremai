/** Build a generic playground stub object from a JSON Schema object. */
export function stubOutputFromSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, prop] of Object.entries(props)) {
    const t = prop.type;
    if (t === 'number' || t === 'integer') stub[key] = 0;
    else if (t === 'boolean') stub[key] = false;
    else if (t === 'array') stub[key] = [];
    else if (t === 'object') stub[key] = {};
    else stub[key] = `playground:${key}`;
  }
  if (!Object.keys(stub).length) stub.result = 'playground stub';
  return stub;
}
