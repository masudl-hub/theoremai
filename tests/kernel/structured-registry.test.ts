import { TheoremError } from '../../src/guardrails/error.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { getStructured, registerStructured } from '../../src/kernel/registry/schemas.ts';
import type { StructuredSpec } from '../../src/kernel/types.ts';

Deno.test('registerStructured stores the schema the model is held to', () => {
  registerStructured('registry.answer', { jsonSchema: { type: 'object' } });
  assertEquals(getStructured('registry.answer').jsonSchema, { type: 'object' });
});

Deno.test('registerStructured rejects the removed enforced field', () => {
  const legacy = { enforced: 'prompt', jsonSchema: { type: 'object' } } as StructuredSpec;
  assertThrows(
    () => registerStructured('registry.legacy', legacy),
    TheoremError,
    'enforced was removed',
  );
});

Deno.test('registerStructured rejects a spec without a JSON Schema object', () => {
  for (const jsonSchema of [undefined, [], 'object']) {
    const spec = { jsonSchema } as unknown as StructuredSpec;
    assertThrows(
      () => registerStructured('registry.bare', spec),
      TheoremError,
      'jsonSchema must be a JSON Schema object',
    );
  }
});
