import type { KeySlot, ModelBinding, Provider } from '../types.ts';

export function providerUsesKeySlots(provider: Provider): boolean {
  return provider === 'google' || provider === 'openrouter';
}

/**
 * The slots a model's calls use: its own, else the profile's. No slot is chosen for the profile:
 * `keySlot` is `undefined` when nothing names one, so a host can use one flat `apiKey`.
 */
function resolveKeySlot(
  profile: { key?: KeySlot; fallbackKey?: KeySlot },
  binding: ModelBinding,
): { keySlot?: KeySlot; fallbackKeySlot?: KeySlot } {
  const keySlot = binding.key ?? profile.key;
  // Only Gemini retries on a second key.
  const fallbackKeySlot =
    binding.provider === 'google' ? (binding.fallbackKey ?? profile.fallbackKey) : undefined;
  return {
    ...(keySlot ? { keySlot } : {}),
    ...(fallbackKeySlot ? { fallbackKeySlot } : {}),
  };
}

export { resolveKeySlot };
