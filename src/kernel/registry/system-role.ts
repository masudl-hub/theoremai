/**
 * Resolve which `systemByRole` key (or handle) applies for a turn.
 *
 * @module
 */

import type { ModelProfile } from '../types.ts';

function pickSystemRole(profile: ModelProfile, requested?: string): string {
  const { handle } = profile.identity;
  const systemByRole = profile.type === 'speech' ? undefined : profile.identity.systemByRole;
  if (requested && systemByRole && Object.hasOwn(systemByRole, requested)) {
    return requested;
  }
  return handle;
}

export { pickSystemRole };
