/**
 * Resolve which `systemByRole` key (or handle) applies for a turn.
 *
 * @module
 */

import type { ModelProfile } from '../types.ts';

function pickSystemRole(profile: ModelProfile, requested?: string): string {
  const { identity } = profile;
  const { handle, systemByRole } = identity;
  if (requested && systemByRole && Object.hasOwn(systemByRole, requested)) {
    return requested;
  }
  return handle;
}

export { pickSystemRole };
