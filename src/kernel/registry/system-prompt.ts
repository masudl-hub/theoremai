/**
 * Synchronous system-prompt resolution for a turn or session.
 * Snapshotted in `resolveTurn` before any async work — never mutate registry per request.
 *
 * @module
 */

import { detectionForTrust, resolveGuardrailPolicy } from '../../guardrails/policy.ts';
import { sanitizeText } from '../../guardrails/sanitize.ts';
import { CONTINUE_INSTRUCTION } from '../stop.ts';
import type { ModelProfile, TurnRequest } from '../types.ts';

function pickSystemRole(profile: ModelProfile, requested?: string): string {
  const { identity } = profile;
  const { handle, systemByRole } = identity;
  if (requested && systemByRole && Object.hasOwn(systemByRole, requested)) {
    return requested;
  }
  return handle;
}

/**
 * Author-time system text for a role (handle or `systemByRole`).
 *
 * Routed through the guardrail policy at `trust: 'trusted'` so the exemption is
 * declared at the point it applies rather than implied by never calling the
 * sanitizer. Trusted resolves to no detection, so the text reaches the provider
 * verbatim — `req.system`, which the host assembles per turn, is handled as
 * `assembled` in `sanitizeTurnRequest` and is not exempt.
 */
function systemFromProfile(profile: ModelProfile, role: string): string {
  const { identity } = profile;
  const { systemByRole, system } = identity;
  const text = systemByRole?.[role] || system || '';
  if (!text) {
    return '';
  }
  const policy = resolveGuardrailPolicy(profile.guardrails);
  return sanitizeText(text, detectionForTrust(policy, 'trusted'));
}

/** Merge profile + host turn system synchronously at resolve time. */
function resolveTurnSystemPrompt(profile: ModelProfile, req: TurnRequest): string {
  const role = pickSystemRole(profile, req.input?.role);
  const continueSys = req.continueFrom ? CONTINUE_INSTRUCTION : '';
  return [systemFromProfile(profile, role), req.system, continueSys].filter(Boolean).join('\n\n');
}

export { pickSystemRole, resolveTurnSystemPrompt, systemFromProfile };
