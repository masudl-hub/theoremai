import { assertEquals, assertThrows } from '@std/assert';
import { z } from 'zod';
import { createProviderRegistry, modelBindingSchema, openRouterProvider } from '../../mod.ts';
import { TheoremError } from '../../src/guardrails/error.ts';

Deno.test('bindings and registrations validate slot names', () => {
  assertThrows(
    () =>
      modelBindingSchema.parse({
        protocol: 'openRouter',
        provider: 'openrouter',
        apiId: 'model',
        keySlot: 'bad slot',
      }),
    z.ZodError,
  );
  assertThrows(
    () => createProviderRegistry().register(openRouterProvider, { keySlot: '' }),
    z.ZodError,
  );
  const error = assertThrows(
    () =>
      createProviderRegistry().register(openRouterProvider, {
        keySlot: 'same',
        fallbackKeySlot: 'same',
      }),
    TheoremError,
  );
  assertEquals(error.kind, 'config');
});
