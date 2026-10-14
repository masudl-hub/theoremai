import { assertEquals } from '@std/assert';
import {
  createExampleDraft,
  defaultEffortRequired,
  defaultModelRequired,
  inputLimitsRequired,
  keySlotUnset,
} from '../../studio/mod.ts';

Deno.test('the default model is required only with more than one model', () => {
  const draft = createExampleDraft();
  assertEquals(defaultModelRequired(draft), true);
  const one = { ...draft, modelBindings: draft.modelBindings.slice(0, 1) };
  assertEquals(defaultModelRequired(one), false);
});

Deno.test("every model but a local one reads no key until a slot is set: its own, its provider's or the profile's", () => {
  const draft = createExampleDraft();
  assertEquals(keySlotUnset(draft), true);
  const own = draft.modelBindings.map((binding) => ({ ...binding, keySlot: 'slot_b' }));
  assertEquals(keySlotUnset({ ...draft, modelBindings: own }), false);
  const local = draft.modelBindings.map((binding) => ({ ...binding, provider: 'local' as const }));
  assertEquals(keySlotUnset({ ...draft, modelBindings: local }), false);
});

Deno.test('a default effort is required only with more than one distinct alias', () => {
  const [fast] = createExampleDraft().modelBindings;
  const [first] = fast.efforts;
  assertEquals(defaultEffortRequired(fast), true);
  assertEquals(defaultEffortRequired({ ...fast, efforts: [first] }), false);
  assertEquals(defaultEffortRequired({ ...fast, efforts: [first, { ...first }] }), false);
  const blank = { ...first, alias: ' ' };
  assertEquals(defaultEffortRequired({ ...fast, efforts: [first, blank] }), false);
});

Deno.test('input limits are required once attachments or voice is on', () => {
  const { inputs } = createExampleDraft();
  const none = { ...inputs, attachmentsAccept: [], voiceAccept: [] };
  assertEquals(inputLimitsRequired(none), false);
  assertEquals(inputLimitsRequired({ ...none, voiceAccept: ['audio/*'] }), true);
  assertEquals(inputLimitsRequired({ ...none, attachmentsAccept: ['application/pdf'] }), true);
});
