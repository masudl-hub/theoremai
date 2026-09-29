import type { ToolRegistry } from '../tools/registry.ts';
import type { BuiltinToolDef } from '../tools/types.ts';
import type { BuiltinToolId, KeySlot, ModelBinding, Provider } from '../types.ts';

function builtinForcesPaid(tools: ToolRegistry, id: BuiltinToolId): boolean {
  const tool = tools.get(id);
  if (tool?.type !== 'builtin') {
    return false;
  }
  return (tool as BuiltinToolDef).forcePaidKey === true;
}

export function providerUsesKeySlots(provider: Provider): boolean {
  return provider === 'google' || provider === 'openrouter';
}

/** `undefined` when nothing pins a slot, so a host can use one flat `apiKey`. */
function resolveKeySlot(
  tools: ToolRegistry,
  profileKey: KeySlot | undefined,
  binding: ModelBinding,
  builtins: BuiltinToolId[],
): KeySlot | undefined {
  if (binding.key) {
    return binding.key;
  }
  if (builtins.some((id) => builtinForcesPaid(tools, id))) {
    return 'paid';
  }
  return profileKey;
}

export { resolveKeySlot };
