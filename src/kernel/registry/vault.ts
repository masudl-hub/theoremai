import { PROVIDER_FACTS } from '../../presets/facts.ts';
import type { KeySlot, ModelBinding } from '../types.ts';

/**
 * The slots a model's calls use: its own, else the profile's. A provider that needs no key uses
 * only the model's own, so the profile's hosted key never reaches it; naming none, it sends no key.
 */
function resolveKeySlot(
  profile: { key?: KeySlot; fallbackKey?: KeySlot },
  binding: ModelBinding,
): { keySlot?: KeySlot; fallbackKeySlot?: KeySlot } {
  const inherited = PROVIDER_FACTS[binding.provider].needsKey ? profile : {};
  const keySlot = binding.key ?? inherited.key;
  const fallbackKeySlot = binding.fallbackKey ?? inherited.fallbackKey;
  return {
    ...(keySlot ? { keySlot } : {}),
    ...(fallbackKeySlot ? { fallbackKeySlot } : {}),
  };
}

export { resolveKeySlot };
