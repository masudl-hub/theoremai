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
	| { kind: 'json' };

export type SchemaField = {
	key: string;
	label: string;
	description?: string;
	isRequired: boolean;
	control: SchemaControl;
};

type Kind = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'unknown';

function kindOf(prop: JsonSchema): Kind {
	const declared = Array.isArray(prop.type) ? prop.type.find((type) => type !== 'null') : prop.type;
	if (declared === 'string' || declared === 'number' || declared === 'integer' || declared === 'boolean' || declared === 'array') return declared;
	if (declared === 'object' || isRow(prop.properties)) return 'object';
	if (Array.isArray(prop.enum)) return 'string';
	return 'unknown';
}

function itemsOf(prop: JsonSchema): JsonSchema | undefined {
	return isRow(prop.items) ? prop.items : undefined;
}

function enumOf(prop: JsonSchema | undefined): string[] | undefined {
	const options = prop?.enum;
	return Array.isArray(options) && options.length > 0 && options.every((option) => typeof option === 'string') ? options : undefined;
}

function numberAt(prop: JsonSchema, key: string): number | undefined {
	const value = prop[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberControl(prop: JsonSchema, isInteger: boolean): SchemaControl {
	const min = numberAt(prop, 'minimum');
	const max = numberAt(prop, 'maximum');
	if (isInteger && min !== undefined && max !== undefined && max > min && max - min <= MAX_SLIDER_STEPS) return { kind: 'range', min, max };
	return { kind: 'number', isInteger, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
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
	if (itemKind === 'string' || itemKind === 'number' || itemKind === 'integer') return { kind: 'words' };
	if (item && itemKind === 'object') return { kind: 'rows', item };
	return { kind: 'json' };
}

/** The input a field's schema asks for. */
export function schemaControl(prop: JsonSchema): SchemaControl {
	const options = enumOf(prop);
	if (options) return { kind: 'choice', options, isMenu: options.length > MAX_SEGMENTS };
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
	return new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
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
				...(typeof prop.description === 'string' && prop.description ? { description: prop.description } : {}),
				isRequired: required.has(key),
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

function sampleValue(prop: JsonSchema): unknown {
	const declared = declaredSample(prop);
	if (declared) return declared.value;
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
		case 'unknown':
			return 'example';
	}
}

/** Required fields, and optional ones the schema gives an example for; a plain value of the field's type when the schema declares no sample. */
export function sampleFromSchema(schema: JsonSchema): Record<string, unknown> {
	const props = isRow(schema.properties) ? schema.properties : {};
	const required = new Set(requiredOf(schema));
	const sample: Record<string, unknown> = {};
	for (const [key, prop] of Object.entries(props)) {
		if (!isRow(prop)) continue;
		if (required.has(key)) sample[key] = sampleValue(prop);
		else if (Array.isArray(prop.examples) && prop.examples.length) sample[key] = prop.examples[0];
	}
	return sample;
}

/** A new row for a list of objects: its required fields, each at its sample. */
export function blankRow(item: JsonSchema): Record<string, unknown> {
	return sampleFromSchema(item);
}

/** The object with `key` set, or dropped when the value is empty. An optional field left empty isn't sent. */
export function withField(row: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
	const next = { ...row };
	if (value === undefined || value === '') delete next[key];
	else next[key] = value;
	return next;
}

/** The labels of required fields the request is still missing, nested ones by their path. */
export function missingFields(schema: JsonSchema, value: unknown, prefix = ''): string[] {
	if (!isRow(value)) return [];
	return schemaFields(schema).flatMap((field) => {
		const entry = value[field.key];
		const label = prefix ? `${prefix} › ${field.label}` : field.label;
		if (entry === undefined || entry === null || entry === '') return field.isRequired ? [label] : [];
		return field.control.kind === 'group' ? missingFields(field.control.schema, entry, label) : [];
	});
}
