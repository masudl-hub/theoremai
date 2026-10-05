import { joinSystemPieces, mapSystemPrompt, systemPieces } from '../system-parts.ts';
import type { ModelProfile, SystemPiece, TurnRequest } from '../types.ts';
import { pickSystemRole } from './system-role.ts';

/**
 * `identity.system` is trusted author-time copy and crosses no boundary: no detector reads it.
 * `req.system` is `assembled` per turn and is read at the `system` boundary.
 */
function systemFromProfile(profile: ModelProfile, role: string): SystemPiece[] {
  if (profile.type === 'speech') {
    return [];
  }
  const { systemByRole, system } = profile.identity;
  const prompt = systemByRole?.[role] || system || '';
  if (!prompt) {
    return [];
  }
  return systemPieces(
    mapSystemPrompt(prompt, `Profile ${profile.id} identity.system`, (text) => text),
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
    systemFromProfile(profile, role),
    req.system === undefined ? [] : systemPieces(req.system),
  ]);
}

export { resolveTurnSystemPrompt };
