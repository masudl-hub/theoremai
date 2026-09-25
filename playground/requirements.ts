/**
 * Conditional requirements — fields a draft must set only in some shapes, so
 * the compiler that reports them and the editor that marks them agree. Mirrors
 * the kernel's rules (see `PROFILE_FIELD_PRESENCE`).
 *
 * @module
 */

import type { InputsDraft, ModelBindingDraft, PlaygroundDraft } from './draft.ts';
import { isGoogleTransport } from './policy.ts';

/** The default model is required once there is more than one model to pick from. */
export function defaultModelRequired(draft: PlaygroundDraft): boolean {
  return draft.modelBindings.length > 1;
}

/** A key slot is required once any model runs on Google, which has no key of its own here. */
export function keySlotRequired(draft: PlaygroundDraft): boolean {
  return draft.modelBindings.some((binding) =>
    isGoogleTransport(binding.protocol, binding.provider)
  );
}

/** A binding's default effort is required once it declares more than one effort. */
export function defaultEffortRequired(binding: ModelBindingDraft): boolean {
  const aliases = binding.efforts.map(({ alias }) => alias.trim()).filter(Boolean);
  return new Set(aliases).size > 1;
}

/** maxFiles, maxBytes and maxTurnBytes are all required once attachments or voice is on. */
export function inputLimitsRequired(inputs: InputsDraft): boolean {
  return inputs.attachmentsAccept.length > 0 || inputs.voiceAccept.length > 0;
}
