import '../fixtures/test-host.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import { resolveTurn } from '../../src/kernel/registry/resolve.ts';
import { providerUsesKeySlots, resolveKeySlot } from '../../src/kernel/registry/vault.ts';
import type { ModelBinding } from '../../src/kernel/types.ts';

const stubBinding: ModelBinding = {
  protocol: 'openAi',
  provider: 'openrouter',
  apiId: 'x',
};

Deno.test('providerUsesKeySlots covers google and openrouter only', () => {
  assertEquals(providerUsesKeySlots('google'), true);
  assertEquals(providerUsesKeySlots('openrouter'), true);
  assertEquals(providerUsesKeySlots('local'), false);
});

Deno.test('resolveKeySlot is optional for openrouter when nothing pins a slot', () => {
  assertEquals(resolveKeySlot(undefined, stubBinding, [], false), undefined);
});

Deno.test('resolveKeySlot is required for google when nothing pins a slot', () => {
  let thrown: unknown;
  try {
    resolveKeySlot(undefined, stubBinding, [], true);
  } catch (err) {
    thrown = err;
  }
  assertEquals(thrown instanceof TheoremError, true);
  assertEquals((thrown as Error).message, 'Profile must set key or models.*.key');
});

Deno.test('openrouter resolveTurn omits keySlot unless profile pins model.key', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'or_flat_key',
      identity: { handle: 'or_flat_key' },
      models: {
        or: {
          protocol: 'openAi',
          provider: 'openrouter',
          apiId: 'openrouter/free',
          efforts: { normal: 'low' },
        },
      },
      tools: { allow: [] },
      inputs: { text: true },
    }),
  );
  assertEquals(
    resolveTurn({ profile: 'or_flat_key', input: { text: 'hi' } }).generation.keySlot,
    undefined,
  );

  registerProfile(
    defineProfile({
      type: 'text',
      id: 'or_slot_key',
      identity: { handle: 'or_slot_key' },
      models: {
        or: {
          protocol: 'openAi',
          provider: 'openrouter',
          apiId: 'openrouter/free',
          efforts: { normal: 'low' },
        },
      },
      key: 'slotB',
      tools: { allow: [] },
      inputs: { text: true },
    }),
  );
  assertEquals(
    resolveTurn({ profile: 'or_slot_key', input: { text: 'hi' } }).generation.keySlot,
    'slotB',
  );
});
