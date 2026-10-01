import '../fixtures/test-host.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import { registerProfile, resolveTurn } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { resolveKeySlot } from '../../src/kernel/registry/vault.ts';
import type { ModelBinding } from '../../src/kernel/types.ts';

const stubBinding: ModelBinding = {
  protocol: 'openAi',
  provider: 'openrouter',
  apiId: 'x',
};

Deno.test('resolveKeySlot names no slot when nothing pins one', () => {
  assertEquals(resolveKeySlot({}, stubBinding), {});
});

Deno.test("a model's own key and fallback win over the profile's", () => {
  const profile = { key: 'team', fallbackKey: 'spare' };
  assertEquals(resolveKeySlot(profile, stubBinding), { keySlot: 'team', fallbackKeySlot: 'spare' });
  assertEquals(resolveKeySlot(profile, { ...stubBinding, key: 'own', fallbackKey: 'own-spare' }), {
    keySlot: 'own',
    fallbackKeySlot: 'own-spare',
  });
});

const google: ModelBinding = {
  protocol: 'geminiInteractions',
  provider: 'google',
  apiId: 'gemini-3.5-flash-lite',
};

function defineError(extra: Record<string, unknown>, binding: ModelBinding = google): string {
  try {
    defineProfile({
      type: 'text',
      id: 'slots',
      identity: { handle: 'slots' },
      models: { m: binding },
      tools: { allow: [] },
      inputs: { text: true },
      ...extra,
    } as Parameters<typeof defineProfile>[0]);
  } catch (err) {
    return (err as Error).message;
  }
  return '';
}

Deno.test('slots take any name the host picks, and a fallback reaches the provider request', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'named_slots',
      identity: { handle: 'named_slots' },
      models: { m: google },
      key: 'team-7',
      fallbackKey: 'backup_2',
      tools: { allow: [] },
      inputs: { text: true },
    }),
  );
  const { generation } = resolveTurn({ profile: 'named_slots', input: { text: 'hi' } });
  assertEquals([generation.keySlot, generation.fallbackKeySlot], ['team-7', 'backup_2']);
});

Deno.test('defineProfile refuses a slot name it cannot use', () => {
  assertEquals(
    defineError({ key: 'my key' }),
    "Profile slots: key 'my key' is not a key slot name; use letters, digits, '-' and '_', up to 32 characters",
  );
});

Deno.test('a fallback must differ from the key', () => {
  assertEquals(
    defineError({ key: 'a', fallbackKey: 'a' }),
    "Profile slots model 'm': fallbackKey 'a' is the same slot as its key",
  );
  assertEquals(defineError({ key: 'a', fallbackKey: 'b' }), '');
});

Deno.test('every provider reads the same slots and fallback', () => {
  const local: ModelBinding = { protocol: 'openAi', provider: 'local', apiId: 'llama' };
  for (const binding of [google, stubBinding, local]) {
    assertEquals(defineError({ key: 'a', fallbackKey: 'b' }, binding), '');
    assertEquals(resolveKeySlot({ key: 'a', fallbackKey: 'b' }, binding), {
      keySlot: 'a',
      fallbackKeySlot: 'b',
    });
  }
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

Deno.test('defineProfile rejects an openrouter model with no key of its own and no profile key', () => {
  const openrouter: ModelBinding = { ...stubBinding, efforts: { normal: 'low' } };
  assertEquals(
    defineError({}, openrouter),
    "Profile slots model 'm': a openrouter model needs models.*.key or the profile key",
  );
  assertEquals(defineError({ key: 'slot_a' }, openrouter), '');
  assertEquals(defineError({}, { ...openrouter, key: 'slot_a' }), '');
});

Deno.test('a local model may name no slot; it sends no key', () => {
  const local: ModelBinding = { protocol: 'openAi', provider: 'local', apiId: 'llama' };
  assertEquals(defineError({}, local), '');
  assertEquals(resolveKeySlot({}, local), {});
});

Deno.test('openrouter resolveTurn carries the slot the profile or its model names', () => {
  const or: ModelBinding = {
    protocol: 'openAi',
    provider: 'openrouter',
    apiId: 'openrouter/free',
    efforts: { normal: 'low' },
  };
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'or_profile_key',
      identity: { handle: 'or_profile_key' },
      models: { or },
      key: 'slot_b',
      tools: { allow: [] },
      inputs: { text: true },
    }),
  );
  assertEquals(
    resolveTurn({ profile: 'or_profile_key', input: { text: 'hi' } }).generation.keySlot,
    'slot_b',
  );

  registerProfile(
    defineProfile({
      type: 'text',
      id: 'or_model_key',
      identity: { handle: 'or_model_key' },
      models: { or: { ...or, key: 'slot_c' } },
      key: 'slot_b',
      tools: { allow: [] },
      inputs: { text: true },
    }),
  );
  assertEquals(
    resolveTurn({ profile: 'or_model_key', input: { text: 'hi' } }).generation.keySlot,
    'slot_c',
  );
});
