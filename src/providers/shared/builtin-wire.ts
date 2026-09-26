/**
 * A builtin's wire name on one transport, read from the request.
 *
 * @module
 */

import { TheoremError } from '../../guardrails/error.ts';
import type { BuiltinWire } from '../../kernel/tools/types.ts';
import type { ProviderBuiltin } from '../../kernel/types.ts';

/** The builtin's wire name on `transport`; throws when it has none. */
function builtinWire(builtin: ProviderBuiltin, transport: keyof BuiltinWire): string {
  const wire = builtin.wire[transport];
  if (!wire) {
    throw new TheoremError('config', `Builtin '${builtin.id}' has no wire.${transport}`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return wire;
}

export { builtinWire };
