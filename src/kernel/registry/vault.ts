import type { KeySlot, ModelBinding } from '../types.ts';

/**
 * The slots a model's calls use: its own, else the profile's. `keySlot` is `undefined` only for a
 * local model that names none: it sends no key.
 */
function resolveKeySlot(
  profile: { key?: KeySlot; fallbackKey?: KeySlot },
  binding: ModelBinding,
): { keySlot?: KeySlot; fallbackKeySlot?: KeySlot } {
  const keySlot = binding.key ?? profile.key;
  const fallbackKeySlot = binding.fallbackKey ?? profile.fallbackKey;
  return {
    ...(keySlot ? { keySlot } : {}),
    ...(fallbackKeySlot ? { fallbackKeySlot } : {}),
  };
}

export { resolveKeySlot };
