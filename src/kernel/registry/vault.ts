/**
 * Gemini vault slot selection for Google Interactions transport.
 *
 * @module
 */

import { TheorumError } from '../../guardrails/error.ts';
import { getTool } from '../tools/registry.ts';
import type { BuiltinToolDef } from '../tools/types.ts';
import type { BuiltinToolId, GeminiBucket, ModelSpec } from '../types.ts';

function builtinForcesPaid(id: BuiltinToolId): boolean {
  const tool = getTool(id);
  if (tool?.type !== 'builtin') {
    return false;
  }
  return (tool as BuiltinToolDef).forcePaidKey === true;
}

/** Pick the vault slot for a turn from profile key, model pin, and enabled builtins. */
function resolveGeminiBucket(
  profileKey: GeminiBucket | undefined,
  spec: ModelSpec,
  builtins: BuiltinToolId[],
): GeminiBucket {
  if (spec.key) {
    return spec.key;
  }
  if (builtins.some((id) => builtinForcesPaid(id))) {
    return 'paid';
  }
  if (!profileKey) {
    throw new TheorumError('Google profile must set model.key or model.config.*.key');
  }
  return profileKey;
}

export { resolveGeminiBucket };
