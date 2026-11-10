import { TheoremError } from '../../guardrails/error.ts';
import type { JsonSchema } from './schema.ts';

/** The keyword on an output field's schema that keeps the field from the model. */
const MODEL_MARK = 'exposeToModel';

const SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions'] as const;
const SCHEMA_LISTS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;
const SCHEMA_ONE = [
  'items',
  'additionalProperties',
  'additionalItems',
  'not',
  'contains',
  'propertyNames',
  'if',
  'then',
  'else',
] as const;

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every schema inside `schema`, itself first, with its JSON Pointer from the root. */
function* eachSchema(schema: unknown, at = '#'): Generator<[JsonSchema, string]> {
  if (!isSchema(schema)) return;
  yield [schema, at];
  for (const key of SCHEMA_MAPS) {
    const map = schema[key];
    if (!isSchema(map)) continue;
    for (const [name, child] of Object.entries(map))
      yield* eachSchema(child, `${at}/${key}/${name}`);
  }
  for (const key of [...SCHEMA_LISTS, ...SCHEMA_ONE]) {
    const child = schema[key];
    if (Array.isArray(child)) {
      for (const [index, entry] of child.entries())
        yield* eachSchema(entry, `${at}/${key}/${index}`);
    } else {
      yield* eachSchema(child, `${at}/${key}`);
    }
  }
}

/** Whether any field of the schema carries the mark. */
function hasModelMark(schema: unknown): boolean {
  for (const [node] of eachSchema(schema)) {
    if (Object.hasOwn(node, MODEL_MARK)) return true;
  }
  return false;
}

/** The schema with the mark taken off every field: the mark is Theorem's, never a provider's. */
export function withoutModelMarks(schema: JsonSchema): JsonSchema {
  if (!hasModelMark(schema)) return schema;
  const copy = structuredClone(schema);
  for (const [node] of eachSchema(copy)) delete node[MODEL_MARK];
  return copy;
}

/** The mark sits on a field of an object: the last step of its pointer is `properties/<name>`. */
const FIELD_AT = /\/properties\/[^/]+$/;

/**
 * Refuses a mark the kernel cannot honour: one that is not `false`, one on the whole output or
 * input, and on an input one that is not on an optional field of an object, which the model,
 * never seeing it, could not fill.
 */
export function assertModelMarks(schema: JsonSchema, where: string, io: 'input' | 'output'): void {
  const refuse = (at: string, problem: string): never => {
    throw new TheoremError('config', `${where} at ${at}: ${problem}`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  };
  for (const [node, at] of eachSchema(schema)) {
    if (!Object.hasOwn(node, MODEL_MARK)) continue;
    if (node[MODEL_MARK] !== false) {
      // labels-exempt: developer contract — a registration error, not end-user or model copy
      refuse(at, `${MODEL_MARK} takes false only`);
    }
    if (io === 'input' && !FIELD_AT.test(at)) {
      // labels-exempt: developer contract — a registration error, not end-user or model copy
      refuse(at, `on an input, ${MODEL_MARK}: false marks a field of an object`);
    }
  }
  if (io === 'input') {
    for (const [node, at] of eachSchema(schema)) {
      const required = Array.isArray(node.required) ? node.required : [];
      for (const [key, child] of Object.entries(fieldsOf(node))) {
        if (hasOwnMark(child) && required.includes(key)) {
          refuse(
            `${at}/properties/${key}`,
            // labels-exempt: developer contract — a registration error, not end-user or model copy
            `an input field marked ${MODEL_MARK}: false must be optional; the model cannot fill it`,
          );
        }
      }
    }
  } else if (hidden(nodesAt(schema, schema))) {
    refuse(
      '#',
      // labels-exempt: developer contract — a registration error, not end-user or model copy
      `${MODEL_MARK}: false on the whole output hides every field; set exposeToModel: false on the tool instead`,
    );
  }
}

function fieldsOf(node: JsonSchema): Record<string, unknown> {
  return isSchema(node.properties) ? node.properties : {};
}

function hasOwnMark(schema: unknown): boolean {
  return isSchema(schema) && schema[MODEL_MARK] === false;
}

/**
 * An input schema as the model reads it: the fields marked `exposeToModel: false` left out and
 * the mark taken off. The host fills those fields; the model never sees them.
 */
export function inputSchemaForModel(schema: JsonSchema): JsonSchema {
  if (!hasModelMark(schema)) return schema;
  const copy = structuredClone(schema);
  for (const [node] of eachSchema(copy)) {
    const fields = fieldsOf(node);
    for (const [key, child] of Object.entries(fields)) if (hasOwnMark(child)) delete fields[key];
  }
  return withoutModelMarks(copy);
}

/** Where a model's input sets a field the schema keeps from the model, as dotted paths; none when it sets none. */
export function markedFieldsIn(schema: JsonSchema, input: unknown): string[] {
  if (!hasModelMark(schema)) return [];
  const found: string[] = [];
  cut(input, nodesAt(schema, schema), (path) => found.push(path));
  return found;
}

/** An input as the model reads it back: the fields marked `exposeToModel: false` left out. */
export function inputForModel(schema: JsonSchema, input: unknown): unknown {
  return outputForModel(schema, input);
}

interface Node {
  schema: JsonSchema;
  root: JsonSchema;
}

function resolvePointer(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (!ref.startsWith('#')) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(1).split('/').slice(1)) {
    const key = decodeURIComponent(raw).replaceAll('~1', '/').replaceAll('~0', '~');
    node =
      isSchema(node) || Array.isArray(node) ? (node as Record<string, unknown>)[key] : undefined;
  }
  return isSchema(node) ? node : undefined;
}

/** The schemas that apply to one value: a reference followed, every branch of a combinator opened. */
function nodesAt(schema: unknown, root: JsonSchema, seen = new Set<JsonSchema>()): Node[] {
  if (!isSchema(schema) || seen.has(schema)) return [];
  seen.add(schema);
  const nodes: Node[] = [{ schema, root }];
  if (typeof schema.$ref === 'string') {
    nodes.push(...nodesAt(resolvePointer(root, schema.$ref), root, seen));
  }
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) nodes.push(...nodesAt(branch, root, seen));
    }
  }
  return nodes;
}

/** invariant: A field one branch of a union marks is kept from the model in every branch. */
function hidden(nodes: readonly Node[]): boolean {
  return nodes.some((node) => node.schema[MODEL_MARK] === false);
}

function childNodes(nodes: readonly Node[], pick: (schema: JsonSchema) => unknown): Node[] {
  return nodes.flatMap((node) => nodesAt(pick(node.schema), node.root));
}

function propertyNodes(nodes: readonly Node[], key: string): Node[] {
  return childNodes(nodes, (schema) => {
    const props = schema.properties;
    if (isSchema(props) && Object.hasOwn(props, key)) return props[key];
    const patterns = schema.patternProperties;
    if (isSchema(patterns)) {
      const match = Object.entries(patterns).find(([pattern]) =>
        new RegExp(pattern, 'u').test(key),
      );
      if (match) return match[1];
    }
    return schema.additionalProperties;
  });
}

function itemNodes(nodes: readonly Node[], index: number): Node[] {
  return childNodes(nodes, (schema) => {
    const tuple = Array.isArray(schema.prefixItems)
      ? schema.prefixItems
      : Array.isArray(schema.items)
        ? schema.items
        : undefined;
    if (tuple)
      return index < tuple.length ? tuple[index] : (schema.additionalItems ?? schema.items);
    return schema.items;
  });
}

function cut(
  value: unknown,
  nodes: readonly Node[],
  onHidden?: (path: string) => void,
  path = '',
): unknown {
  if (nodes.length === 0) return value;
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const children = itemNodes(nodes, index);
      const at = `${path}[${String(index)}]`;
      if (hidden(children)) {
        onHidden?.(at);
        return [];
      }
      return [cut(item, children, onHidden, at)];
    });
  }
  if (isSchema(value)) {
    const kept: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const children = propertyNodes(nodes, key);
      const at = path ? `${path}.${key}` : key;
      if (hidden(children)) onHidden?.(at);
      else kept[key] = cut(child, children, onHidden, at);
    }
    return kept;
  }
  return value;
}

/**
 * The output as the model reads it: every field whose schema says `exposeToModel: false` is left
 * out, at any depth. The output itself is not changed.
 */
export function outputForModel(schema: JsonSchema | undefined, output: unknown): unknown {
  if (!schema || !hasModelMark(schema)) return output;
  return cut(output, nodesAt(schema, schema));
}

function prefixRefs(schema: JsonSchema, base: string): JsonSchema {
  const copy = structuredClone(schema);
  for (const [node] of eachSchema(copy)) {
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#')) {
      node.$ref = `${base}${node.$ref.slice(1)}`;
    }
  }
  return copy;
}

/**
 * An agent tool's output schema with `structured` read as any reply schema the called agent can
 * give, so a field one of them marks is kept from the calling model.
 */
export function agentOutputSchema(
  outputSchema: JsonSchema,
  structured: readonly JsonSchema[],
): JsonSchema {
  const marked = structured.filter(hasModelMark);
  if (marked.length === 0) return outputSchema;
  const defs = Object.fromEntries(
    marked.map((spec, index) => [`reply${index}`, prefixRefs(spec, `#/$defs/reply${index}`)]),
  );
  const properties = isSchema(outputSchema.properties) ? outputSchema.properties : {};
  return {
    ...outputSchema,
    properties: {
      ...properties,
      structured: { anyOf: marked.map((_, index) => ({ $ref: `#/$defs/reply${index}` })) },
    },
    $defs: { ...(isSchema(outputSchema.$defs) ? outputSchema.$defs : {}), ...defs },
  };
}
