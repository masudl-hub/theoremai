import { joinSystemPieces, mapSystemPrompt, systemPieces } from '../system-parts.ts';
import type { ModelProfile, SystemPiece, TurnRequest } from '../types.ts';
import { fillSlots } from './slot-fill.ts';
import { pickSystemRole } from './system-role.ts';

/**
 * `identity.system` is trusted author-time copy and crosses no boundary: no detector reads it.
 * A `{slot}` in it becomes the value the request chose, which is one the profile lists.
 * `req.system` is `assembled` per turn and is read at the `system` boundary.
 */
function systemFromProfile(
  profile: ModelProfile,
  role: string,
  slots: Record<string, string> | undefined,
): SystemPiece[] {
  if (profile.type === 'speech') {
    return [];
  }
  const { systemByRole, system } = profile.identity;
  const prompt = systemByRole?.[role] || system || '';
  if (!prompt) {
    return [];
  }
  return systemPieces(
    mapSystemPrompt(prompt, `Profile ${profile.id} identity.system`, (text) =>
      fillSlots(profile, text, slots, 'identity.system'),
    ),
  );
}

/**
 * Synchronous: snapshotted in `resolveTurn` before any async work. Each source
 * keeps its own marks: a `{ private }` part in `req.system` leaves the
 * profile's prompt as private as it was written.
 */
function resolveTurnSystemPrompt(profile: ModelProfile, req: TurnRequest): SystemPiece[] {
  const role = pickSystemRole(profile, req.input?.role);
  return joinSystemPieces([
    systemFromProfile(profile, role, req.input?.slots),
    req.system === undefined ? [] : systemPieces(req.system),
  ]);
}

export { resolveTurnSystemPrompt };
