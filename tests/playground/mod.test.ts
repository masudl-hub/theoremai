import { assertEquals } from '@std/assert';
import {
  demoHttpSampleInput,
  demoInputsSpec,
  demoToolSpecs,
  playgroundDemoHandler,
  sampleFromJsonSchema,
  sampleToolInput,
  stubOutputFromSchema,
} from '../../playground/mod.ts';

Deno.test('demoToolSpecs includes http and function tools', () => {
  const seeds = demoToolSpecs();
  assertEquals(seeds.length >= 20, true);
  assertEquals(
    seeds.some((s) => s.data.toolType === 'http'),
    true,
  );
  assertEquals(
    seeds.some((s) => s.data.toolType === 'function'),
    true,
  );
});

Deno.test('demoHttpSampleInput covers geocode_city', () => {
  const input = demoHttpSampleInput('geocode_city');
  assertEquals(input?.name, 'Paris');
});

Deno.test('playgroundDemoHandler convert_units', () => {
  const handler = playgroundDemoHandler('convert_units');
  if (!handler) {
    throw new Error('missing convert_units handler');
  }
  const out = handler({ value: 32, from: 'f', to: 'c' });
  assertEquals(typeof out.result, 'number');
});

Deno.test('stubOutputFromSchema maps properties', () => {
  const stub = stubOutputFromSchema({
    properties: { name: { type: 'string' }, count: { type: 'integer' } },
  });
  assertEquals(typeof stub.name, 'string');
  assertEquals(stub.count, 0);
});

Deno.test('sampleFromJsonSchema fills required fields, preferring declared examples', () => {
  const sample = sampleFromJsonSchema({
    type: 'object',
    properties: {
      city: { type: 'string', examples: ['Lisbon'] },
      units: { type: 'string', enum: ['metric', 'imperial'] },
      days: { type: 'integer', minimum: 3 },
      exact: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' } },
      where: {
        type: 'object',
        properties: { lat: { type: 'number', default: 38.7 }, note: { type: 'string' } },
        required: ['lat'],
      },
      note: { type: 'string' },
    },
    required: ['city', 'units', 'days', 'exact', 'tags', 'where', 'missing'],
  });
  assertEquals(sample, {
    city: 'Lisbon',
    units: 'metric',
    days: 3,
    exact: true,
    tags: [],
    where: { lat: 38.7 },
  });
});

Deno.test('sampleToolInput prefers the demo input, then the schema', () => {
  assertEquals(sampleToolInput('get_weather', ''), { latitude: 48.85, longitude: 2.35 });
  assertEquals(
    sampleToolInput('my_tool', '{"properties":{"q":{"type":"string"}},"required":["q"]}'),
    { q: 'example' },
  );
  assertEquals(sampleToolInput('my_tool', 'not json'), undefined);
});

Deno.test('demoInputsSpec enables multimodal inputs', () => {
  const spec = demoInputsSpec();
  assertEquals(spec.text, true);
  assertEquals(spec.attachmentsAccept.length > 0, true);
});
