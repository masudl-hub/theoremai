import '../fixtures/test-host.ts';
import { TheorumError } from '../../src/guardrails/error.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import { resolveTurn } from '../../src/kernel/registry/resolve.ts';
import { providerUsesKeySlots, resolveKeySlot } from '../../src/kernel/registry/vault.ts';

Deno.test('providerUsesKeySlots covers google and openrouter only', () => {
  assertEquals(providerUsesKeySlots('google'), true);
  assertEquals(providerUsesKeySlots('openrouter'), true);
  assertEquals(providerUsesKeySlots('local'), false);
});

Deno.test('resolveKeySlot is optional for openrouter when nothing pins a slot', () => {
  assertEquals(resolveKeySlot(undefined, { apiId: 'x' }, [], false), undefined);
});

Deno.test('resolveKeySlot is required for google when nothing pins a slot', () => {
  let thrown: unknown;
  try {
    resolveKeySlot(undefined, { apiId: 'x' }, [], true);
  } catch (err) {
    thrown = err;
  }
  assertEquals(thrown instanceof TheorumError, true);
  assertEquals((thrown as Error).message, 'Profile must set model.key or model.config.*.key');
});

Deno.test('openrouter resolveTurn omits keySlot unless profile pins model.key', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'or_flat_key',
      identity: { handle: 'or_flat_key' },
      model: {
        protocol: 'openAi',
        provider: 'openrouter',
        allow: ['or'],
        thinking: 'low',
        config: { or: { apiId: 'openrouter/free' } },
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
      model: {
        protocol: 'openAi',
        provider: 'openrouter',
        allow: ['or'],
        key: 'slotB',
        thinking: 'low',
        config: { or: { apiId: 'openrouter/free' } },
      },
      tools: { allow: [] },
      inputs: { text: true },
    }),
  );
  assertEquals(
    resolveTurn({ profile: 'or_slot_key', input: { text: 'hi' } }).generation.keySlot,
    'slotB',
  );
});
