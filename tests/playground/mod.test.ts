import { assertEquals } from '@std/assert';
import {
  demoHttpSampleInput,
  demoInputsSpec,
  demoToolSpecs,
  playgroundDemoHandler,
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

Deno.test('demoInputsSpec enables multimodal inputs', () => {
  const spec = demoInputsSpec();
  assertEquals(spec.text, true);
  assertEquals(spec.attachmentsAccept.length > 0, true);
});
