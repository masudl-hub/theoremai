/**
 * Vault key-slot selection for credentialed transports (Google, OpenRouter, …).
 *
 * @module
 */

import { TheoremError } from '../../guardrails/error.ts';
import { getTool } from '../tools/registry.ts';
import type { BuiltinToolDef } from '../tools/types.ts';
import type { BuiltinToolId, KeySlot, ModelBinding, Provider } from '../types.ts';

function builtinForcesPaid(id: BuiltinToolId): boolean {
  const tool = getTool(id);
  if (tool?.type !== 'builtin') {
    return false;
  }
  return (tool as BuiltinToolDef).forcePaidKey === true;
}

/** Providers that resolve a vault `keySlot` on each turn. */
export function providerUsesKeySlots(provider: Provider): boolean {
  return provider === 'google' || provider === 'openrouter';
}

/**
 * Pick the key slot for a turn from profile key, model pin, and enabled builtins.
 *
 * When `required` is false and nothing pins a slot, returns `undefined` so hosts
 * can use a single flat `apiKey` (OpenRouter without a vault).
 */
function resolveKeySlot(
  profileKey: KeySlot | undefined,
  binding: ModelBinding,
  builtins: BuiltinToolId[],
  required: boolean,
): KeySlot | undefined {
  if (binding.key) {
    return binding.key;
  }
  if (builtins.some((id) => builtinForcesPaid(id))) {
    return 'paid';
  }
  if (profileKey) {
    return profileKey;
  }
  if (required) {
    throw new TheoremError('config', 'Profile must set key or models.*.key'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return undefined;
}

export { resolveKeySlot };
