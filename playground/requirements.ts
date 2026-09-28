/** Shared by the compiler and the editor so both agree; mirrors the kernel's `PROFILE_FIELD_PRESENCE`. */

import type { InputsDraft, ModelBindingDraft, PlaygroundDraft } from './draft.ts';
import { isGoogleTransport } from './policy.ts';

export function defaultModelRequired(draft: PlaygroundDraft): boolean {
  return draft.modelBindings.length > 1;
}

/** A key slot is required once any model runs on Google, which has no key of its own here. */
export function keySlotRequired(draft: PlaygroundDraft): boolean {
  return draft.modelBindings.some((binding) =>
    isGoogleTransport(binding.protocol, binding.provider)
  );
}

export function defaultEffortRequired(binding: ModelBindingDraft): boolean {
  const aliases = binding.efforts.map(({ alias }) => alias.trim()).filter(Boolean);
  return new Set(aliases).size > 1;
}

export function inputLimitsRequired(inputs: InputsDraft): boolean {
  return inputs.attachmentsAccept.length > 0 || inputs.voiceAccept.length > 0;
}
