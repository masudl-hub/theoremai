import { assertEquals } from '@std/assert';
import { bindingSlots, createExampleDraft, keySlotRequired, modelSlots } from '../../studio/mod.ts';
import type { StudioProvider } from '../../studio/providers.ts';

const providers: StudioProvider[] = [
  { id: 'openrouter', adapter: 'openrouter', keySlot: 'team', fallbackKeySlot: 'spare' },
  { id: 'local', adapter: 'openai-chat' },
];

Deno.test("a model that names no key slot reads its provider's", () => {
  assertEquals(modelSlots(providers, { provider: 'openrouter' }), {
    keySlot: 'team',
    fallbackKeySlot: 'spare',
  });
  assertEquals(
    modelSlots(providers, { provider: 'openrouter', keySlot: '', fallbackKeySlot: '' }),
    {
      keySlot: 'team',
      fallbackKeySlot: 'spare',
    },
  );
});

Deno.test('a model reads the key slot it names', () => {
  assertEquals(modelSlots(providers, { provider: 'openrouter', keySlot: 'mine' }), {
    keySlot: 'mine',
    fallbackKeySlot: 'spare',
  });
});

Deno.test('a model reads no key slot when its provider has none, or is not registered', () => {
  assertEquals(modelSlots(providers, { provider: 'local' }), {});
  assertEquals(modelSlots(providers, { provider: 'gone' }), {});
});

Deno.test("a profile asks for no key slot when each model's provider gives one", () => {
  const example = createExampleDraft();
  const draft = {
    ...example,
    providers,
    models: { ...example.models, key: '' as const },
    modelBindings: example.modelBindings.map((binding) => ({
      ...binding,
      provider: 'openrouter',
      keySlot: '' as const,
      fallbackKeySlot: '' as const,
    })),
  };
  assertEquals(keySlotRequired(draft), false);
  const [first] = draft.modelBindings;
  // The slot is the provider's: the keys panel asks for it, and the profile does not write it.
  assertEquals(bindingSlots(draft, first), {
    keySlot: 'team',
    fallbackKeySlot: 'spare',
    given: { keySlot: true, fallbackKeySlot: true },
  });
  const named = { ...draft, models: { ...draft.models, key: 'slot_b' as const } };
  assertEquals(bindingSlots(named, first).given, { keySlot: false, fallbackKeySlot: true });
});
