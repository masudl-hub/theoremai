/**
 * The rules behind a tool's request form: which input each JSON Schema field
 * gets, what the form starts filled with, and what a request still lacks.
 * The component only maps each decision to its Astryx input.
 *
 * @module
 */

import { humanize, isRow } from './shaped-data.ts';

export type JsonSchema = Record<string, unknown>;

/** Choices this few sit side by side; more open a menu. */
const MAX_SEGMENTS = 5;
/** Whole numbers bounded this closely slide; wider ranges are typed. */
const MAX_SLIDER_STEPS = 100;
/** Text allowed this long gets a text area. */
const LONG_TEXT = 120;

/** The input a field gets. */
export type SchemaControl =
  | { kind: 'choice'; options: string[]; isMenu: boolean }
  | { kind: 'range'; min: number; max: number }
  | { kind: 'number'; isInteger: boolean; min?: number; max?: number }
  | { kind: 'switch' }
  | { kind: 'date' }
  | { kind: 'text'; isLong: boolean; type: 'text' | 'email' }
  | { kind: 'choices'; options: string[] }
  | { kind: 'words' }
  | { kind: 'rows'; item: JsonSchema }
  | { kind: 'group'; schema: JsonSchema }
  | { kind: 'branches'; branches: SchemaBranch[]; isMenu: boolean }
  | { kind: 'json' };

/**
 * One of the shapes a field of several (`anyOf` or `oneOf`) can take, and how its value shows
 * which: `key` holds the constant `is`, or, with no `is`, the object holds `key` alone.
 */
export type SchemaBranch = {
  label: string;
  key: string;
  is?: string | number | boolean;
  /** What the form asks for in this shape: the rest of the object, or the value under `key`. */
  body: JsonSchema;
};

export type SchemaField = {
  key: string;
  label: string;
  description?: string;
  isRequired: boolean;
  /** The field also takes `null`, which the form sends only when asked: left out stays left out. */
  isNullable?: true;
  control: SchemaControl;
};

type Kind = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'unknown';

function kindOf(prop: JsonSchema): Kind {
  const declared = Array.isArray(prop.type) ? prop.type.find((type) => type !== 'null') : prop.type;
  if (
    declared === 'string' ||
    declared === 'number' ||
    declared === 'integer' ||
    declared === 'boolean' ||
    declared === 'array'
  )
    return declared;
  if (declared === 'object' || isRow(prop.properties)) return 'object';
  if (Array.isArray(prop.enum)) return 'string';
  return 'unknown';
}

function itemsOf(prop: JsonSchema): JsonSchema | undefined {
  return isRow(prop.items) ? prop.items : undefined;
}

function enumOf(prop: JsonSchema | undefined): string[] | undefined {
  const options = prop?.enum;
  return Array.isArray(options) &&
    options.length > 0 &&
    options.every((option) => typeof option === 'string')
    ? options
    : undefined;
}

function optionsOf(prop: JsonSchema): JsonSchema[] | undefined {
  const options = Array.isArray(prop.anyOf)
    ? prop.anyOf
    : Array.isArray(prop.oneOf)
      ? prop.oneOf
      : undefined;
  return options?.filter(isRow);
}

const isNullSchema = (prop: JsonSchema) => prop.type === 'null';

/** The field's schema without its `null` option, and whether it has one. */
function withoutNull(prop: JsonSchema): { schema: JsonSchema; isNullable: boolean } {
  if (Array.isArray(prop.type) && prop.type.includes('null')) {
    return { schema: prop, isNullable: true };
  }
  const options = optionsOf(prop);
  if (!options?.some(isNullSchema)) return { schema: prop, isNullable: false };
  const rest = options.filter((option) => !isNullSchema(option));
  const { anyOf: _anyOf, oneOf: _oneOf, ...own } = prop;
  const [only] = rest;
  return {
    schema: rest.length === 1 && only ? { ...only, ...own } : { ...own, anyOf: rest },
    isNullable: true,
  };
}

function constOf(prop: unknown): string | number | boolean | undefined {
  if (!isRow(prop)) return undefined;
  const value =
    'const' in prop
      ? prop.const
      : Array.isArray(prop.enum) && prop.enum.length === 1
        ? prop.enum[0]
        : undefined;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : undefined;
}

function titleOf(prop: JsonSchema): string | undefined {
  return typeof prop.title === 'string' && prop.title ? prop.title : undefined;
}

const isDistinct = (values: readonly unknown[]) => new Set(values).size === values.length;

/** Shapes told apart by a property each holds a different constant in. */
function taggedBranches(options: JsonSchema[]): SchemaBranch[] | undefined {
  const shapes = options.map((option) => option.properties as Record<string, unknown>);
  for (const key of Object.keys(shapes[0] ?? {})) {
    const tags = shapes.map((shape) => constOf(shape[key]));
    if (!isDistinct(tags)) continue;
    const branches = options.map((option, at): SchemaBranch | undefined => {
      const is = tags[at];
      if (is === undefined) return undefined;
      const { [key]: _tag, ...rest } = shapes[at] ?? {};
      const required = Array.isArray(option.required)
        ? { required: option.required.filter((name) => name !== key) }
        : {};
      return {
        label: titleOf(option) ?? humanize(String(is)),
        key,
        is,
        body: { ...option, properties: rest, ...required },
      };
    });
    if (branches.every((branch) => branch !== undefined)) return branches;
  }
  return undefined;
}

/** Shapes that each hold one key of their own: the key says which. */
function keyedBranches(options: JsonSchema[]): SchemaBranch[] | undefined {
  const branches = options.map((option): SchemaBranch | undefined => {
    const entries = Object.entries(option.properties as Record<string, unknown>);
    const [entry] = entries;
    if (entries.length !== 1 || !entry || !isRow(entry[1])) return undefined;
    const [key, body] = entry;
    return { label: titleOf(option) ?? humanize(key), key, body };
  });
  if (!branches.every((branch) => branch !== undefined)) return undefined;
  return isDistinct(branches.map((branch) => branch.key)) ? branches : undefined;
}

/** The shapes of a field of several objects, when its value shows which one it is in. */
function branchesOf(prop: JsonSchema): SchemaBranch[] | undefined {
  const options = optionsOf(prop);
  if (!options || options.length < 2 || !options.every((option) => isRow(option.properties))) {
    return undefined;
  }
  return taggedBranches(options) ?? keyedBranches(options);
}

/** The shape `value` is in, if it is in one. */
export function chosenBranch(
  branches: readonly SchemaBranch[],
  value: unknown,
): SchemaBranch | undefined {
  if (!isRow(value)) return undefined;
  return branches.find((branch) =>
    branch.is === undefined ? Object.hasOwn(value, branch.key) : value[branch.key] === branch.is,
  );
}

/** The part of `value` a shape's body edits. */
export function branchValue(branch: SchemaBranch, value: unknown): unknown {
  if (!isRow(value)) return undefined;
  if (branch.is === undefined) return value[branch.key];
  const { [branch.key]: _tag, ...rest } = value;
  return rest;
}

/** The value in `branch` with `body` as its body. */
export function inBranch(branch: SchemaBranch, body: unknown): Record<string, unknown> {
  if (branch.is === undefined) return { [branch.key]: body };
  return { ...(isRow(body) ? body : {}), [branch.key]: branch.is };
}

/** A shape's body as a field of its own, labelled as the shape. */
export function branchField(branch: SchemaBranch): SchemaField {
  return {
    key: branch.key,
    label: branch.label,
    isRequired: true,
    control:
      branch.is === undefined ? schemaControl(branch.body) : { kind: 'group', schema: branch.body },
  };
}

/** A value in `branch`, its body at its sample. */
export function branchSample(branch: SchemaBranch): Record<string, unknown> {
  return inBranch(branch, sampleValue(branch.body));
}

function numberAt(prop: JsonSchema, key: string): number | undefined {
  const value = prop[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberControl(prop: JsonSchema, isInteger: boolean): SchemaControl {
  const min = numberAt(prop, 'minimum');
  const max = numberAt(prop, 'maximum');
  if (
    isInteger &&
    min !== undefined &&
    max !== undefined &&
    max > min &&
    max - min <= MAX_SLIDER_STEPS
  )
    return { kind: 'range', min, max };
  return {
    kind: 'number',
    isInteger,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };
}

function textControl(prop: JsonSchema): SchemaControl {
  if (prop.format === 'date') return { kind: 'date' };
  const maxLength = numberAt(prop, 'maxLength');
  return {
    kind: 'text',
    isLong: maxLength === undefined ? false : maxLength > LONG_TEXT,
    type: prop.format === 'email' ? 'email' : 'text',
  };
}

function listControl(prop: JsonSchema): SchemaControl {
  const item = itemsOf(prop);
  const choices = enumOf(item);
  if (choices) return { kind: 'choices', options: choices };
  const itemKind = item ? kindOf(item) : 'unknown';
  if (itemKind === 'string' || itemKind === 'number' || itemKind === 'integer')
    return { kind: 'words' };
  if (item && itemKind === 'object') return { kind: 'rows', item };
  return { kind: 'json' };
}

/** The input a field's schema asks for. */
export function schemaControl(field: JsonSchema): SchemaControl {
  const prop = withoutNull(field).schema;
  const options = enumOf(prop);
  if (options) return { kind: 'choice', options, isMenu: options.length > MAX_SEGMENTS };
  const branches = branchesOf(prop);
  if (branches) return { kind: 'branches', branches, isMenu: branches.length > MAX_SEGMENTS };
  switch (kindOf(prop)) {
    case 'boolean':
      return { kind: 'switch' };
    case 'number':
      return numberControl(prop, false);
    case 'integer':
      return numberControl(prop, true);
    case 'string':
      return textControl(prop);
    case 'array':
      return listControl(prop);
    case 'object':
      return isRow(prop.properties) ? { kind: 'group', schema: prop } : { kind: 'json' };
    default:
      return { kind: 'json' };
  }
}

function requiredOf(schema: JsonSchema): Set<string> {
  return new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : [],
  );
}

/** An object schema's fields in the order it declares them, each with its input. */
export function schemaFields(schema: JsonSchema): SchemaField[] {
  const props = isRow(schema.properties) ? schema.properties : {};
  const required = requiredOf(schema);
  return Object.entries(props).flatMap(([key, prop]) => {
    if (!isRow(prop)) return [];
    return [
      {
        key,
        label: typeof prop.title === 'string' && prop.title ? prop.title : humanize(key),
        ...(typeof prop.description === 'string' && prop.description
          ? { description: prop.description }
          : {}),
        isRequired: required.has(key),
        ...(withoutNull(prop).isNullable ? { isNullable: true as const } : {}),
        control: schemaControl(prop),
      },
    ];
  });
}

/** The schema's own example for a value: `examples[0]`, then `default`, `const`, `enum[0]`. */
function declaredSample(prop: JsonSchema): { value: unknown } | undefined {
  if (Array.isArray(prop.examples) && prop.examples.length) return { value: prop.examples[0] };
  if ('default' in prop) return { value: prop.default };
  if ('const' in prop) return { value: prop.const };
  if (Array.isArray(prop.enum) && prop.enum.length) return { value: prop.enum[0] };
  return undefined;
}

function sampleValue(field: JsonSchema): unknown {
  const declared = declaredSample(field);
  if (declared) return declared.value;
  const prop = withoutNull(field).schema;
  const branches = branchesOf(prop);
  if (branches?.[0]) return branchSample(branches[0]);
  switch (kindOf(prop)) {
    case 'number':
    case 'integer':
      return numberAt(prop, 'minimum') ?? 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return sampleFromSchema(prop);
    case 'string':
      return 'example';
    case 'unknown':
      // why: No sample fits a value of no known shape; the field waits for the person.
      return undefined;
  }
}

/** Required fields, and optional ones the schema gives an example for; a plain value of the field's type when the schema declares no sample. */
export function sampleFromSchema(schema: JsonSchema): Record<string, unknown> {
  const branches = branchesOf(schema);
  if (branches?.[0]) return branchSample(branches[0]);
  const props = isRow(schema.properties) ? schema.properties : {};
  const required = new Set(requiredOf(schema));
  const sample: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(props)) {
    if (!isRow(prop)) continue;
    if (required.has(key)) {
      const value = sampleValue(prop);
      if (value !== undefined) sample[key] = value;
    } else if (Array.isArray(prop.examples) && prop.examples.length) sample[key] = prop.examples[0];
  }
  return sample;
}

/** A new row for a list of objects: its required fields, each at its sample. */
export function blankRow(item: JsonSchema): Record<string, unknown> {
  return sampleFromSchema(item);
}

/** The object with `key` set, or dropped when the value is empty. An optional field left empty isn't sent. */
export function withField(
  row: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const next = { ...row };
  if (value === undefined || value === '') delete next[key];
  else next[key] = value;
  return next;
}

/** The labels of required fields the request is still missing, nested ones by their path. */
export function missingFields(schema: JsonSchema, value: unknown, prefix = ''): string[] {
  const branches = branchesOf(schema);
  if (branches) {
    const branch = chosenBranch(branches, value);
    if (!branch) return [];
    // why: A keyed shape's one key is the field a top-level request lacks when it is empty.
    const label = prefix || (branch.is === undefined ? branch.label : '');
    return missingIn(branchField(branch), branchValue(branch, value), label);
  }
  if (!isRow(value)) return [];
  return schemaFields(schema).flatMap((field) =>
    missingIn(field, value[field.key], prefix ? `${prefix} › ${field.label}` : field.label),
  );
}

/** What `entry`, the value of `field`, still lacks: the field itself, or what its shape needs. */
function missingIn(field: SchemaField, entry: unknown, label: string): string[] {
  if (entry === null && field.isNullable) return [];
  if (entry === undefined || entry === null || entry === '') return field.isRequired ? [label] : [];
  const { control } = field;
  if (control.kind === 'group') return missingFields(control.schema, entry, label);
  if (control.kind === 'branches') {
    const branch = chosenBranch(control.branches, entry);
    return branch ? missingIn(branchField(branch), branchValue(branch, entry), label) : [label];
  }
  return [];
}
