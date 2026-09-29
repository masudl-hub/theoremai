import '../fixtures/test-host.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import { registerProfile, resolveTurn } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { providerUsesKeySlots, resolveKeySlot } from '../../src/kernel/registry/vault.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
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

Deno.test('resolveKeySlot is undefined when nothing pins a slot', () => {
  assertEquals(resolveKeySlot(defaultKernelScope.tools, undefined, stubBinding, []), undefined);
});

Deno.test('defineProfile rejects a google model with no key of its own and no profile key', () => {
  let thrown: unknown;
  try {
    defineProfile({
      type: 'text',
      id: 'google_no_key',
      identity: { handle: 'google_no_key' },
      models: {
        flash: {
          protocol: 'geminiInteractions',
          provider: 'google',
          apiId: 'gemini-3.5-flash-lite',
        },
      },
      tools: { allow: [] },
      inputs: { text: true },
    });
  } catch (err) {
    thrown = err;
  }
  assertEquals(thrown instanceof TheoremError, true);
  assertEquals(
    (thrown as Error).message,
    "Profile google_no_key model 'flash': a google model needs models.*.key or the profile key",
  );
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
