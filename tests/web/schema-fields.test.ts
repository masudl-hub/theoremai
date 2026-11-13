import { assertEquals } from '@std/assert';
import {
  branchSample,
  branchValue,
  chosenBranch,
  inBranch,
  missingFields,
  sampleFromSchema,
  schemaControl,
  schemaFields,
  withField,
} from '../../web/src/client/schema-fields.ts';

Deno.test('schemaControl picks the input each field type asks for', () => {
  assertEquals(schemaControl({ type: 'string', enum: ['c', 'f'] }), {
    kind: 'choice',
    options: ['c', 'f'],
    isMenu: false,
  });
  assertEquals(
    schemaControl({ type: 'string', enum: ['a', 'b', 'c', 'd', 'e', 'f'] }).kind,
    'choice',
  );
  assertEquals(schemaControl({ type: 'integer', minimum: 1, maximum: 10 }), {
    kind: 'range',
    min: 1,
    max: 10,
  });
  assertEquals(schemaControl({ type: 'number', minimum: -90, maximum: 90 }), {
    kind: 'number',
    isInteger: false,
    min: -90,
    max: 90,
  });
  assertEquals(schemaControl({ type: 'boolean' }), { kind: 'switch' });
  assertEquals(schemaControl({ type: 'string', format: 'date' }), { kind: 'date' });
  assertEquals(schemaControl({ type: 'string', maxLength: 2000 }), {
    kind: 'text',
    isLong: true,
    type: 'text',
  });
  assertEquals(schemaControl({ type: 'array', items: { type: 'string', enum: ['x', 'y'] } }), {
    kind: 'choices',
    options: ['x', 'y'],
  });
  assertEquals(schemaControl({ type: 'array', items: { type: 'string' } }), { kind: 'words' });
  assertEquals(
    schemaControl({ type: 'array', items: { type: 'object', properties: {} } }).kind,
    'rows',
  );
  assertEquals(
    schemaControl({ type: 'object', properties: { a: { type: 'string' } } }).kind,
    'group',
  );
  assertEquals(schemaControl({}), { kind: 'json' });
  assertEquals(schemaControl({ type: ['number', 'null'] }).kind, 'number');
});

Deno.test('schemaFields labels by title, else the key in words, and marks required', () => {
  const fields = schemaFields({
    type: 'object',
    properties: {
      country_code: { type: 'string', description: 'ISO code' },
      q: { type: 'string', title: 'Query' },
    },
    required: ['q'],
  });
  assertEquals(
    fields.map((field) => [field.label, field.isRequired, field.description]),
    [
      ['Country code', false, 'ISO code'],
      ['Query', true, undefined],
    ],
  );
});

Deno.test('sampleFromSchema fills required fields, preferring declared examples', () => {
  assertEquals(
    sampleFromSchema({
      type: 'object',
      properties: {
        city: { type: 'string', examples: ['Paris'] },
        days: { type: 'integer', minimum: 1 },
        note: { type: 'string' },
      },
      required: ['city', 'days'],
    }),
    { city: 'Paris', days: 1 },
  );
});

Deno.test('withField drops an emptied optional field; missingFields names required gaps by path', () => {
  assertEquals(withField({ a: 1, b: 'x' }, 'b', ''), { a: 1 });
  const schema = {
    type: 'object',
    properties: {
      city: { type: 'string' },
      where: { type: 'object', properties: { lat: { type: 'number' } }, required: ['lat'] },
    },
    required: ['city', 'where'],
  };
  assertEquals(missingFields(schema, { city: '', where: {} }), ['City', 'Where › Lat']);
  assertEquals(missingFields(schema, { city: 'Paris', where: { lat: 1 } }), []);
});

Deno.test('sampleFromSchema fills an optional field only when the schema gives an example', () => {
  const schema = {
    type: 'object',
    properties: {
      q: { type: 'string', examples: ['Paris'] },
      limit: { type: 'number', examples: [5] },
      lang: { type: 'string' },
    },
    required: ['q'],
  };
  assertEquals(sampleFromSchema(schema), { q: 'Paris', limit: 5 });
});

// One of several actions, each an object that holds one key.
const ACTION = {
  anyOf: [
    {
      type: 'object',
      properties: {
        create: {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title'],
        },
      },
      required: ['create'],
    },
    {
      type: 'object',
      properties: { delete: { type: 'string' } },
      required: ['delete'],
      title: 'Remove',
    },
  ],
};
// A shape, or null to clear it.
const SCHEDULE = {
  anyOf: [
    { type: 'object', properties: { at: { type: 'string' } }, required: ['at'] },
    { type: 'null' },
  ],
  description: 'When it runs',
};

Deno.test('a field of several shapes picks one, labelled by its title or its one key', () => {
  const control = schemaControl(ACTION);
  if (control.kind !== 'branches') throw new Error(`a choice of shapes, not ${control.kind}`);
  assertEquals(
    control.branches.map((branch) => [branch.label, branch.key, branch.is]),
    [
      ['Create', 'create', undefined],
      ['Remove', 'delete', undefined],
    ],
  );
  assertEquals(chosenBranch(control.branches, { delete: 'x' })?.label, 'Remove');
  assertEquals(chosenBranch(control.branches, { other: 1 }), undefined);
});

Deno.test('shapes told apart by a constant are picked by it, and the constant is not a field', () => {
  const control = schemaControl({
    oneOf: [
      {
        type: 'object',
        properties: { k: { const: 'pin' }, at: { type: 'string' } },
        required: ['k', 'at'],
      },
      { type: 'object', properties: { k: { const: 'drop' } }, required: ['k'] },
    ],
  });
  if (control.kind !== 'branches') throw new Error(`a choice of shapes, not ${control.kind}`);
  const [pin] = control.branches;
  assertEquals([pin?.label, pin?.key, pin?.is], ['Pin', 'k', 'pin']);
  assertEquals(Object.keys((pin?.body.properties ?? {}) as object), ['at']);
  assertEquals(pin?.body.required, ['at']);
  if (!pin) throw new Error('no pin shape');
  assertEquals(branchValue(pin, { k: 'pin', at: 'noon' }), { at: 'noon' });
  assertEquals(inBranch(pin, { at: 'noon' }), { at: 'noon', k: 'pin' });
  assertEquals(branchSample(pin), { k: 'pin', at: 'example' });
});

Deno.test('a request of several shapes starts at the first one, and what it lacks follows the one picked', () => {
  const schema = { type: 'object', properties: { action: ACTION }, required: ['action'] };
  assertEquals(sampleFromSchema(schema), { action: { create: { title: 'example' } } });
  assertEquals(missingFields(schema, { action: { create: {} } }), ['Action › Title']);
  assertEquals(missingFields(schema, { action: { delete: '' } }), ['Action']);
  assertEquals(missingFields(schema, { action: { delete: 'x' } }), []);
  assertEquals(missingFields(schema, { action: { other: 1 } }), ['Action']);
  // A tool whose whole input is one of several shapes.
  assertEquals(sampleFromSchema(ACTION), { create: { title: 'example' } });
  assertEquals(missingFields(ACTION, { create: {} }), ['Create › Title']);
  assertEquals(missingFields(ACTION, { delete: '' }), ['Remove']);
});

Deno.test('a field that takes null reads as its other shape, and null is a value, not a gap', () => {
  const schema = { type: 'object', properties: { schedule: SCHEDULE }, required: ['schedule'] };
  const [field] = schemaFields(schema);
  assertEquals(
    [field?.isNullable, field?.control.kind, field?.description],
    [true, 'group', 'When it runs'],
  );
  assertEquals(missingFields(schema, { schedule: null }), []);
  assertEquals(missingFields(schema, {}), ['Schedule']);
  assertEquals(missingFields(schema, { schedule: {} }), ['Schedule › At']);
  assertEquals(sampleFromSchema(schema), { schedule: { at: 'example' } });
  // Left out and null stay two values.
  assertEquals(withField({}, 'schedule', null), { schedule: null });
  assertEquals(withField({ schedule: null }, 'schedule', undefined), {});
  assertEquals(
    schemaFields({ type: 'object', properties: { n: { type: ['number', 'null'] } } })[0]
      ?.isNullable,
    true,
  );
  assertEquals(
    schemaFields({ type: 'object', properties: { n: { type: 'number' } } })[0]?.isNullable,
    undefined,
  );
});

Deno.test('a required field of no known shape starts empty, so the form says it is missing', () => {
  const schema = { type: 'object', properties: { blob: {} }, required: ['blob'] };
  assertEquals(sampleFromSchema(schema), {});
  assertEquals(missingFields(schema, {}), ['Blob']);
  assertEquals(schemaControl({ anyOf: [{ type: 'string' }, { type: 'number' }] }), {
    kind: 'json',
  });
});
