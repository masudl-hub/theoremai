import { assertEquals, assertThrows } from '@std/assert';
import { z } from 'zod';
import { defineProvider, modelBindingSchema } from '../../mod.ts';
import { resolveKeySlot } from '../../src/kernel/registry/vault.ts';
import { openRouterAdapter } from '../../src/providers/mod.ts';

Deno.test('model credential slot overrides provider defaults without an implied fallback', () => {
  assertEquals(
    resolveKeySlot(
      { keySlot: 'company', fallbackKeySlot: 'backup' },
      { provider: 'company', apiId: 'model', keySlot: 'own' },
    ),
    { keySlot: 'own', fallbackKeySlot: 'backup' },
  );
  assertEquals(resolveKeySlot({}, { provider: 'company', apiId: 'model' }), {});
  assertEquals(resolveKeySlot({ keySlot: 'company' }, { provider: 'company', apiId: 'model' }), {
    keySlot: 'company',
  });
});
Deno.test('definitions and bindings validate slot names', () => {
  assertThrows(
    () => modelBindingSchema.parse({ provider: 'company', apiId: 'model', keySlot: 'bad slot' }),
    z.ZodError,
  );
  assertThrows(
    () =>
      defineProvider({ id: 'company', connection: {}, keySlot: '', adapter: openRouterAdapter() }),
    z.ZodError,
  );
  assertThrows(
    () =>
      defineProvider({
        id: 'company',
        connection: {},
        keySlot: 'same',
        fallbackKeySlot: 'same',
        adapter: openRouterAdapter(),
      }),
    Error,
    'must differ',
  );
});
