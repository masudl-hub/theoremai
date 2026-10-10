import type { ProviderDefinition } from '../provider-contract.ts';
import type { ModelBinding } from '../types.ts';

function resolveKeySlot(
  provider: Pick<ProviderDefinition, 'keySlot' | 'fallbackKeySlot'>,
  binding: ModelBinding,
) {
  const keySlot = binding.keySlot ?? provider.keySlot;
  const fallbackKeySlot = binding.fallbackKeySlot ?? provider.fallbackKeySlot;
  return { ...(keySlot ? { keySlot } : {}), ...(fallbackKeySlot ? { fallbackKeySlot } : {}) };
}

export { resolveKeySlot };
