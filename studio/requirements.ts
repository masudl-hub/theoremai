/** Shared by the compiler and the editor so both agree; mirrors the kernel's `PROFILE_FIELD_PRESENCE`. */

import type { InputsDraft, ModelBindingDraft, StudioDraft } from './draft.ts';
import { modelSlots } from './providers.ts';

export function defaultModelRequired(draft: StudioDraft): boolean {
  return draft.modelBindings.length > 1;
}

/**
 * Whether a model other than a local one reads no vault slot: not its own, its provider's, or the
 * profile's. The kernel runs it without a key, so a provider that needs one refuses the run.
 */
export function keySlotUnset(draft: StudioDraft): boolean {
  return draft.modelBindings.some(
    (binding) => binding.provider !== 'local' && !modelSlots(draft.providers, binding).keySlot,
  );
}

/**
 * The key slots a model of `draft` reads: its own, the profile's, or its provider's. Each says
 * whether it is the provider's, which the profile does not write.
 */
export function bindingSlots(
  draft: StudioDraft,
  binding: ModelBindingDraft,
): {
  keySlot?: string;
  fallbackKeySlot?: string;
  given: { keySlot: boolean; fallbackKeySlot: boolean };
} {
  const written = {
    provider: binding.provider,
    keySlot: binding.keySlot || draft.models.key,
    fallbackKeySlot: binding.fallbackKeySlot || draft.models.fallbackKey,
  };
  const read = modelSlots(draft.providers, written);
  return {
    ...read,
    given: {
      keySlot: Boolean(read.keySlot) && !written.keySlot,
      fallbackKeySlot: Boolean(read.fallbackKeySlot) && !written.fallbackKeySlot,
    },
  };
}

export function defaultEffortRequired(binding: ModelBindingDraft): boolean {
  const aliases = binding.efforts.map(({ alias }) => alias.trim()).filter(Boolean);
  return new Set(aliases).size > 1;
}

export function inputLimitsRequired(inputs: InputsDraft): boolean {
  return inputs.attachmentsAccept.length > 0 || inputs.voiceAccept.length > 0;
}
