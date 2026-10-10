/** Shared by the compiler and the editor so both agree; mirrors the kernel's `PROFILE_FIELD_PRESENCE`. */

import type { InputsDraft, ModelBindingDraft, StudioDraft } from './draft.ts';

export function defaultModelRequired(draft: StudioDraft): boolean {
  return draft.modelBindings.length > 1;
}

/** Every model but a local one reads a vault slot: its own, or the profile's. */
export function keySlotRequired(draft: StudioDraft): boolean {
  return draft.modelBindings.some((binding) => !binding.keySlot && binding.provider !== 'local');
}

export function defaultEffortRequired(binding: ModelBindingDraft): boolean {
  const aliases = binding.efforts.map(({ alias }) => alias.trim()).filter(Boolean);
  return new Set(aliases).size > 1;
}

export function inputLimitsRequired(inputs: InputsDraft): boolean {
  return inputs.attachmentsAccept.length > 0 || inputs.voiceAccept.length > 0;
}
