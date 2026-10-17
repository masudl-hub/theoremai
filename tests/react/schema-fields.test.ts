import { assertEquals } from '@std/assert';
import {
  missingFields,
  sampleFromSchema,
  schemaControl,
  schemaFields,
  withField,
} from '../../react/src/client/schema-fields.ts';

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
