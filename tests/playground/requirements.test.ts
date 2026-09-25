import { assertEquals } from '@std/assert';
import {
  createExampleDraft,
  defaultEffortRequired,
  defaultModelRequired,
  inputLimitsRequired,
  keySlotRequired,
} from '../../playground/mod.ts';

Deno.test('the default model is required only with more than one model', () => {
  const draft = createExampleDraft();
  assertEquals(defaultModelRequired(draft), true);
  const one = { ...draft, modelBindings: draft.modelBindings.slice(0, 1) };
  assertEquals(defaultModelRequired(one), false);
});

Deno.test('a key slot is required only when a model runs on Google', () => {
  const draft = createExampleDraft();
  const open = draft.modelBindings.filter(({ provider }) => provider !== 'google');
  assertEquals(keySlotRequired(draft), true);
  assertEquals(keySlotRequired({ ...draft, modelBindings: open }), false);
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
