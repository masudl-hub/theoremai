/**
 * A tool's schema as the builder's file writes it in Zod: the `z.` call it starts from, each
 * method called on it, and the object its fields are written in. Save reads a schema this way to
 * change one part of it where that part is written, and writes a new part as Zod.
 *
 * @module
 */

import ts from 'typescript';
import { z } from 'zod';
import { jsonSchemaFromZod } from '../../src/kernel/tools/schema.ts';
import { type SourceStyle, valueSource } from '../source.ts';
import { keySource, quoteSource } from '../tool-schema.ts';
import { canonical } from './canonical.ts';
import {
  type Env,
  followed,
  type Located,
  type ProjectSource,
  propertyName,
  type ShapeEntry,
  shapeOf,
  unwrapped,
} from './project-source.ts';

/** One call in a schema's expression: `z.string()`, `.describe('…')`. */
export interface ZodCall {
  /** The method called. */
  name: string;
  call: ts.CallExpression;
  source: ts.SourceFile;
  env?: Env;
}

/** A schema as the files write it. */
export interface ZodRead {
  /** The `z.` call it starts from. */
  base: ZodCall;
  /** Each method called on it since, the last one first. */
  chain: ZodCall[];
  /** A name stands for some of it: a constant, a function's parameter. */
  named: boolean;
}

/** Which side of a tool a schema checks. The kernel reads the two a little differently. */
export type SchemaSide = 'input' | 'output';

const ZOD_NAMES = new WeakMap<ts.SourceFile, Set<string>>();

/** The names a file knows Zod by: `z`, as a rule. */
function zodNames(source: ts.SourceFile): Set<string> {
  const known = ZOD_NAMES.get(source);
  if (known) return known;
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    if (!/^(npm:)?zod(@[^/]*)?(\/.*)?$/.test(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (clause?.name) names.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === 'z') names.add(element.name.text);
      }
    }
  }
  ZOD_NAMES.set(source, names);
  return names;
}

/** The name `source` calls Zod by, to write a new schema in it. */
export function zodName(source: ts.SourceFile): string | undefined {
  const [first] = zodNames(source);
  return first;
}

/** How far a schema is followed through names and calls. */
const MAX_HOPS = 32;

/**
 * Reads the schema an expression stands for. A name is followed to the constant it stands for,
 * and a project function to what it returns. Undefined when it does not lead to a `z.` call.
 */
export function readZod(project: ProjectSource, at: Located): ZodRead | undefined {
  const chain: ZodCall[] = [];
  let here: Located = { ...at, node: unwrapped(at.node) };
  let named = false;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const { node, source, env } = here;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const owner = unwrapped(node.expression.expression);
      const call = { name: node.expression.name.text, call: node, source, ...(env ? { env } : {}) };
      if (ts.isIdentifier(owner) && zodNames(source).has(owner.text) && !env?.bound.has(owner.text)) {
        return { base: call, chain, named };
      }
      chain.push(call);
      here = { ...here, node: owner };
      continue;
    }
    const next = followed(project, here);
    if (next.node === node && next.source === source) return undefined;
    named = true;
    here = next;
  }
  return undefined;
}

/** The methods a schema keeps its fields, its description and its kind through. */
const READ_THROUGH = new Set([
  'describe',
  'optional',
  'nullable',
  'extend',
  'refine',
  'superRefine',
  'check',
  'brand',
  'readonly',
  'strict',
  'passthrough',
  'loose',
  'min',
  'max',
  'length',
  'nonempty',
  'int',
  'positive',
  'negative',
  'nonnegative',
  'nonpositive',
  'gt',
  'gte',
  'lt',
  'lte',
  'multipleOf',
  'email',
  'url',
  'uuid',
  'regex',
  'trim',
  'toLowerCase',
  'toUpperCase',
  'startsWith',
  'endsWith',
  'includes',
]);

/** The first method the studio does not read a schema through: what it returns is for code to say. */
export function unread(read: ZodRead): ZodCall | undefined {
  return read.chain.find((call) => !READ_THROUGH.has(call.name));
}

/** The last call of a method on a schema: the one that counts. */
export function methodCall(read: ZodRead, name: string): ZodCall | undefined {
  return read.chain.find((call) => call.name === name);
}

/** The text of a method call with its dot, from the end of what it is called on. */
export function methodSpan(call: ZodCall): { start: number; end: number } {
  return { start: (call.call.expression as ts.PropertyAccessExpression).expression.end, end: call.call.end };
}

const OBJECTS = new Set(['object', 'strictObject', 'looseObject']);

/** An object schema's fields, as the files write them. */
export interface ZodObject {
  /** Each field by name. One an `.extend()` writes again is the one held. */
  entries: Map<string, ShapeEntry>;
  /** The object a new field is written in: the last `.extend()`, or the `z.object()` itself. */
  own: { node: ts.ObjectLiteralExpression; source: ts.SourceFile };
  /** Set when an `.extend()` adds to the fields. */
  extended: boolean;
}

/**
 * The fields of an object schema. Undefined for another kind of schema, and for an object whose
 * fields the studio cannot list: a spread it could not follow, a key the file computes.
 */
export function zodObject(project: ProjectSource, read: ZodRead): ZodObject | undefined {
  if (!OBJECTS.has(read.base.name)) return undefined;
  const calls = [read.base, ...read.chain.filter((call) => call.name === 'extend').reverse()];
  const entries = new Map<string, ShapeEntry>();
  let own: ZodObject['own'] | undefined;
  for (const { call, source, env } of calls) {
    const [fields] = call.arguments;
    if (!fields || ts.isSpreadElement(fields) || call.arguments.length !== 1) return undefined;
    const shape = shapeOf(project, followed(project, { node: fields, source, ...(env ? { env } : {}) }));
    if (!shape?.own || shape.open) return undefined;
    for (const entry of shape.entries.values()) {
      entries.delete(entry.key);
      entries.set(entry.key, entry);
    }
    own = shape.own;
  }
  return own ? { entries, own, extended: calls.length > 1 } : undefined;
}

/** The kinds of schema the studio writes itself, so it can write one of them again whole. */
const WRITTEN_KINDS = new Set([
  'string',
  'number',
  'int',
  'boolean',
  'null',
  'unknown',
  'any',
  'enum',
  'literal',
  'array',
  'union',
  'record',
  'email',
  'url',
  'uuid',
  ...OBJECTS,
]);

/** The methods whose effect the JSON Schema shows, so writing the schema again from it keeps them. */
const WRITTEN_METHODS = new Set([
  'describe',
  'optional',
  'nullable',
  'default',
  'min',
  'max',
  'nonempty',
  'int',
  'positive',
  'negative',
  'nonnegative',
  'nonpositive',
  'gt',
  'gte',
  'lt',
  'lte',
  'multipleOf',
  'email',
  'url',
  'uuid',
  'regex',
]);

/**
 * Whether a schema is written out in full where it stands, in Zod the studio writes itself. Such
 * a schema can be written again from its JSON Schema with nothing lost: no name stands for a part
 * of it, and it has no check or change that only its code holds.
 */
export function isWrittenOut(project: ProjectSource, at: Located): boolean {
  const read = readZod(project, at);
  if (!read || read.named || !WRITTEN_KINDS.has(read.base.name)) return false;
  if (read.chain.some((call) => !WRITTEN_METHODS.has(call.name))) return false;
  const { source, env } = read.base;
  const parts = partsWritten(read.base);
  return parts !== undefined && parts.every((node) => isWrittenOut(project, { node, source, ...(env ? { env } : {}) }));
}

/** The schemas a `z.` call holds, when it lists each one. */
function partsWritten(base: ZodCall): ts.Expression[] | undefined {
  const parts: ts.Expression[] = [];
  for (const argument of base.call.arguments) {
    const node = unwrapped(argument);
    if (ts.isSpreadElement(node)) return undefined;
    if (OBJECTS.has(base.name)) {
      const fields = fieldsWritten(node);
      if (!fields) return undefined;
      parts.push(...fields);
    } else if (base.name === 'union') {
      if (!ts.isArrayLiteralExpression(node) || node.elements.some(ts.isSpreadElement)) return undefined;
      parts.push(...node.elements);
    } else if (base.name === 'array' || base.name === 'record') parts.push(node);
  }
  return parts;
}

/** The schema of each field an object lists by name. */
function fieldsWritten(node: ts.Expression): ts.Expression[] | undefined {
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  const fields: ts.Expression[] = [];
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || propertyName(property) === undefined) return undefined;
    fields.push(property.initializer);
  }
  return fields;
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A schema being written: its Zod as text, and the same Zod live, to check what it reads as. */
interface Draft {
  text: string;
  live: z.ZodType;
}

const SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

class Writer {
  constructor(
    private readonly name: string,
    private readonly side: SchemaSide,
    private readonly style: SourceStyle,
  ) {}

  private quote(text: string): string {
    return valueSource(text, this.style);
  }

  private pads(depth: number): [pad: string, close: string] {
    const { base, unit } = this.style;
    return [base + unit.repeat(depth + 1), base + unit.repeat(depth)];
  }

  private only(schema: Json, known: readonly string[]): boolean {
    return Object.keys(schema).every((key) => known.includes(key));
  }

  /** A schema with its description and default. Undefined for one the studio does not write as Zod. */
  schema(schema: unknown, depth: number): Draft | undefined {
    if (!isRecord(schema)) return undefined;
    const { description, default: preset, ...rest } = schema;
    let draft = this.kind(rest, depth);
    if (!draft) return undefined;
    if (description !== undefined) {
      if (typeof description !== 'string') return undefined;
      draft = { text: `${draft.text}.describe(${this.quote(description)})`, live: draft.live.describe(description) };
    }
    if ('default' in schema) {
      let written: string;
      try {
        written = valueSource(preset, { ...this.style, base: this.pads(depth)[1] });
      } catch {
        return undefined;
      }
      draft = { text: `${draft.text}.default(${written})`, live: draft.live.default(preset) };
    }
    return draft;
  }

  private kind(schema: Json, depth: number): Draft | undefined {
    const { type } = schema;
    if (Object.keys(schema).length === 0) return { text: `${this.name}.unknown()`, live: z.unknown() };
    if (Array.isArray(type)) return this.kinds(schema, type, depth);
    if (Array.isArray(schema.anyOf)) return this.only(schema, ['anyOf']) ? this.union(schema.anyOf, depth) : undefined;
    if ('const' in schema) return this.literal(schema);
    if (Array.isArray(schema.enum)) return this.choice(schema, schema.enum);
    return this.typed(schema, depth);
  }

  /** A schema of more than one type: the one type that can be null, or a union of them. */
  private kinds(schema: Json, type: readonly unknown[], depth: number): Draft | undefined {
    const kinds = type.filter((each) => each !== 'null');
    const [one] = kinds;
    const held = kinds.length === 1 && one
      ? this.kind({ ...schema, type: one }, depth)
      : this.only(schema, ['type'])
      ? this.union(kinds.map((each) => ({ type: each })), depth)
      : undefined;
    if (!held || kinds.length === type.length) return held;
    return { text: `${held.text}.nullable()`, live: held.live.nullable() };
  }

  private literal(schema: Json): Draft | undefined {
    const { const: value } = schema;
    const plain = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    if (!plain || !this.only(schema, ['type', 'const'])) return undefined;
    return { text: `${this.name}.literal(${valueSource(value, this.style)})`, live: z.literal(value) };
  }

  private choice(schema: Json, among: readonly unknown[]): Draft | undefined {
    const values = among.filter((each): each is string => typeof each === 'string');
    const [first, ...others] = values;
    if (first === undefined || values.length !== among.length || !this.only(schema, ['type', 'enum'])) return undefined;
    const items = values.map((each) => this.quote(each)).join(', ');
    return { text: `${this.name}.enum([${items}])`, live: z.enum([first, ...others]) };
  }

  /** A schema of one type. */
  private typed(schema: Json, depth: number): Draft | undefined {
    const n = this.name;
    const { type } = schema;
    if (type === 'string') return this.text(schema);
    if (type === 'number' || type === 'integer') return this.number(schema);
    if (type === 'boolean' && this.only(schema, ['type'])) return { text: `${n}.boolean()`, live: z.boolean() };
    if (type === 'null' && this.only(schema, ['type'])) return { text: `${n}.null()`, live: z.null() };
    if (type === 'array') return this.list(schema, depth);
    if (type === 'object') return this.object(schema, depth);
    return undefined;
  }

  private union(members: readonly unknown[], depth: number): Draft | undefined {
    const drafts = members.map((member) => this.schema(member, depth + 1));
    const held = drafts.filter((draft): draft is Draft => draft !== undefined);
    const [first, second, ...others] = held;
    if (!first || !second || held.length !== drafts.length) return undefined;
    const [pad, close] = this.pads(depth);
    const lines = held.map((draft) => `${pad}${draft.text},`).join('\n');
    return {
      text: `${this.name}.union([\n${lines}\n${close}])`,
      live: z.union([first.live, second.live, ...others.map((draft) => draft.live)]),
    };
  }

  private text(schema: Json): Draft | undefined {
    const n = this.name;
    const { minLength, maxLength, pattern, format } = schema;
    if (!this.only(schema, ['type', 'minLength', 'maxLength', 'pattern', 'format'])) return undefined;
    let draft: { text: string; live: z.ZodString | z.ZodEmail | z.ZodURL | z.ZodUUID };
    if (format === undefined) draft = { text: `${n}.string()`, live: z.string() };
    else if (format === 'email') draft = { text: `${n}.email()`, live: z.email() };
    else if (format === 'uri') draft = { text: `${n}.url()`, live: z.url() };
    else if (format === 'uuid') draft = { text: `${n}.uuid()`, live: z.uuid() };
    else return undefined;
    if (typeof minLength === 'number') draft = { text: `${draft.text}.min(${String(minLength)})`, live: draft.live.min(minLength) };
    if (typeof maxLength === 'number') draft = { text: `${draft.text}.max(${String(maxLength)})`, live: draft.live.max(maxLength) };
    // A format brings its own pattern: the check below says whether this one is it.
    if (typeof pattern === 'string' && format === undefined) {
      let held: RegExp;
      try {
        held = new RegExp(pattern);
      } catch {
        return undefined;
      }
      draft = { text: `${draft.text}.regex(new RegExp(${this.quote(pattern)}))`, live: draft.live.regex(held) };
    }
    return draft;
  }

  private number(schema: Json): Draft | undefined {
    const n = this.name;
    if (!this.only(schema, ['type', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'])) return undefined;
    const whole = schema.type === 'integer';
    let draft: { text: string; live: z.ZodNumber } = whole ? { text: `${n}.int()`, live: z.int() } : { text: `${n}.number()`, live: z.number() };
    const limits: Array<[key: string, method: 'min' | 'max' | 'gt' | 'lt' | 'multipleOf', given?: number]> = [
      ['minimum', 'min', whole ? -SAFE_INTEGER : undefined],
      ['maximum', 'max', whole ? SAFE_INTEGER : undefined],
      ['exclusiveMinimum', 'gt'],
      ['exclusiveMaximum', 'lt'],
      ['multipleOf', 'multipleOf'],
    ];
    for (const [key, method, given] of limits) {
      const value = schema[key];
      if (value === undefined || value === given) continue;
      if (typeof value !== 'number') return undefined;
      draft = { text: `${draft.text}.${method}(${String(value)})`, live: draft.live[method](value) };
    }
    return draft;
  }

  private list(schema: Json, depth: number): Draft | undefined {
    if (!this.only(schema, ['type', 'items', 'minItems', 'maxItems'])) return undefined;
    const items = this.schema(schema.items ?? {}, depth);
    if (!items) return undefined;
    let draft = { text: `${this.name}.array(${items.text})`, live: z.array(items.live) };
    const { minItems, maxItems } = schema;
    if (typeof minItems === 'number') draft = { text: `${draft.text}.min(${String(minItems)})`, live: draft.live.min(minItems) };
    if (typeof maxItems === 'number') draft = { text: `${draft.text}.max(${String(maxItems)})`, live: draft.live.max(maxItems) };
    return draft;
  }

  private object(schema: Json, depth: number): Draft | undefined {
    const n = this.name;
    if (!this.only(schema, ['type', 'properties', 'required', 'additionalProperties', 'propertyNames'])) return undefined;
    const { properties = {}, required = [], additionalProperties: more, propertyNames } = schema;
    if (!isRecord(properties) || !Array.isArray(required)) return undefined;
    const fields = Object.entries(properties);
    if (isRecord(more) && Object.keys(more).length > 0) {
      // Any key, each with one kind of value.
      const values = fields.length === 0 && canonical(propertyNames ?? { type: 'string' }) === canonical({ type: 'string' })
        ? this.schema(more, depth)
        : undefined;
      return values && { text: `${n}.record(${n}.string(), ${values.text})`, live: z.record(z.string(), values.live) };
    }
    if (propertyNames !== undefined) return undefined;
    const open = more === true || isRecord(more);
    if (!open && more !== undefined && more !== false) return undefined;
    // The kernel reads an object a tool returns as closed, so there a plain one says so.
    const kind = open ? 'looseObject' : more === false && this.side === 'input' ? 'strictObject' : 'object';
    const shape: Record<string, z.ZodType> = {};
    const lines: string[] = [];
    const [pad, close] = this.pads(depth);
    for (const [key, value] of fields) {
      const field = this.field(value, !required.includes(key), depth + 1);
      if (!field) return undefined;
      shape[key] = field.live;
      lines.push(`${pad}${keySource(key)}: ${field.text},`);
    }
    const text = lines.length ? `${n}.${kind}({\n${lines.join('\n')}\n${close}})` : `${n}.${kind}({})`;
    return { text, live: z[kind](shape) };
  }

  /** A field of an object: its schema, and whether the object can leave it out. */
  field(schema: unknown, optional: boolean, depth: number): Draft | undefined {
    const draft = this.schema(schema, depth);
    // A field with a default can be left out as it is.
    if (!draft || !optional || (isRecord(schema) && 'default' in schema)) return draft;
    return { text: `${draft.text}.optional()`, live: draft.live.optional() };
  }
}

/** A schema as the kernel reads it once the studio has run it: Zod's reading of the JSON. */
function asRun(schema: unknown, side: SchemaSide): unknown {
  return jsonSchemaFromZod(z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]), side);
}

const STUDIO_STYLE: SourceStyle = { unit: '  ', base: '', template: true, quote: quoteSource };

/**
 * A JSON Schema as Zod, laid out in `style`, with `name` for Zod. `optional` writes a field its
 * object can leave out. Undefined when the studio has no Zod for it, or when the kernel would
 * not read that Zod back as the schema the builder ran: Save then leaves it for code.
 */
export function zodSource(
  schema: unknown,
  optional: boolean,
  side: SchemaSide,
  name: string,
  style: SourceStyle = STUDIO_STYLE,
): string | undefined {
  try {
    const field = new Writer(name, side, style).field(schema, optional, 0);
    if (!field) return undefined;
    const read = jsonSchemaFromZod(z.object({ field: field.live }), side) as Json;
    const fields = isRecord(read.properties) ? read.properties : {};
    const left = !(Array.isArray(read.required) && read.required.includes('field'));
    if (left !== optional) return undefined;
    // The same schema, or the same once Zod has read both: `integer` gains its bounds there.
    const held = canonical(fields.field) === canonical(schema) ||
      canonical(asRun(fields.field, side)) === canonical(asRun(schema, side));
    return held ? field.text : undefined;
  } catch {
    return undefined;
  }
}
