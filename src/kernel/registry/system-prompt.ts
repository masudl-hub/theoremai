import { type KeptSystemLine, pickSystemLines, turnFacts } from '../system-lines.ts';
import { joinSystemPieces, systemPieces } from '../system-parts.ts';
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
  req: TurnRequest,
): KeptSystemLine[] {
  if (profile.type === 'speech') {
    return [];
  }
  const { systemByRole, system } = profile.identity;
  const prompt = systemByRole?.[role] || system || '';
  if (!prompt) {
    return [];
  }
  const facts = turnFacts(profile.id, profile.identity.conditions, req, slots);
  return pickSystemLines(prompt, facts, (text) =>
    fillSlots(profile, text, slots, 'identity.system'),
  );
}

/**
 * Synchronous: snapshotted in `resolveTurn` before any async work. Each source
 * keeps its own marks: a `{ private }` part in `req.system` leaves the
 * profile's prompt as private as it was written.
 */
function resolveTurnSystem(
  profile: ModelProfile,
  req: TurnRequest,
): { pieces: SystemPiece[]; lines: number[] } {
  const role = pickSystemRole(profile, req.input?.role);
  const kept = systemFromProfile(profile, role, req.input?.slots, req);
  return {
    pieces: joinSystemPieces([
      ...kept.map(({ pieces }) => pieces),
      req.system === undefined ? [] : systemPieces(req.system),
    ]),
    lines: kept.map(({ line }) => line),
  };
}

/** The whole prompt a turn sends, for what reads it outside a turn. */
function resolveTurnSystemPrompt(profile: ModelProfile, req: TurnRequest): SystemPiece[] {
  return resolveTurnSystem(profile, req).pieces;
}

export { resolveTurnSystem, resolveTurnSystemPrompt };
