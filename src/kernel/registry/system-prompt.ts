import { type KeptSystemLine, pickSystemLines } from '../system-lines.ts';
import { joinSystemPieces, systemPieces } from '../system-parts.ts';
import type { ModelProfile, SystemPiece, TurnRequest } from '../types.ts';
import { fillOptions, turnFacts } from './options.ts';

/**
 * `identity.system` is trusted author-time copy and crosses no boundary: no detector reads it.
 * A `{name}` in it becomes the value the request set, which is one the profile lists.
 * `req.system` is `assembled` per turn and is read at the `system` boundary.
 */
function systemFromProfile(profile: ModelProfile, req: TurnRequest): KeptSystemLine[] {
  if (profile.type === 'speech' || profile.type === 'transcription') {
    return [];
  }
  const prompt = profile.identity.system;
  if (!prompt) {
    return [];
  }
  const facts = turnFacts(profile, req);
  return pickSystemLines(prompt, facts, (text) => fillOptions(profile, text, facts));
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
  const kept = systemFromProfile(profile, req);
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
