import type { KeySlot, ModelBinding } from '../types.ts';

/**
 * The slots a model's calls use: its own, else the profile's. A local model uses only its own, so
 * the profile's hosted key never reaches a local server; naming none, it sends no key.
 */
function resolveKeySlot(
  profile: { key?: KeySlot; fallbackKey?: KeySlot },
  binding: ModelBinding,
): { keySlot?: KeySlot; fallbackKeySlot?: KeySlot } {
  const inherited = binding.provider === 'local' ? {} : profile;
  const keySlot = binding.key ?? inherited.key;
  const fallbackKeySlot = binding.fallbackKey ?? inherited.fallbackKey;
  return {
    ...(keySlot ? { keySlot } : {}),
    ...(fallbackKeySlot ? { fallbackKeySlot } : {}),
  };
}

export { resolveKeySlot };
