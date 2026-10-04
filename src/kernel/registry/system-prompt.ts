import { detectionForTrust, resolveGuardrailPolicy } from '../../guardrails/policy.ts';
import { sanitizeText } from '../../guardrails/sanitize.ts';
import { joinSystemPieces, mapSystemPrompt, systemPieces } from '../system-parts.ts';
import type { ModelProfile, SystemPiece, TurnRequest } from '../types.ts';
import { pickSystemRole } from './system-role.ts';

/**
 * Routed through the policy at `trust: 'trusted'` so the exemption is declared where it applies,
 * not implied by skipping the sanitizer. `req.system` is `assembled` per turn and not exempt.
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
  const detection = detectionForTrust(resolveGuardrailPolicy(profile.guardrails), 'trusted');
  return systemPieces(
    mapSystemPrompt(prompt, `Profile ${profile.id} identity.system`, (text) =>
      sanitizeText(text, detection),
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
    systemFromProfile(profile, role),
    req.system === undefined ? [] : systemPieces(req.system),
  ]);
}

export { resolveTurnSystemPrompt };
