/**
 * Synchronous system-prompt resolution for a turn or session.
 * Snapshotted in `resolveTurn` before any async work — never mutate registry per request.
 *
 * @module
 */

import { lexiconText } from '../../guardrails/lexicon.ts';
import { detectionForTrust, resolveGuardrailPolicy } from '../../guardrails/policy.ts';
import { sanitizeText } from '../../guardrails/sanitize.ts';
import { profileTurnResumption } from '../stop.ts';
import type { ModelProfile, TurnRequest } from '../types.ts';
import { pickSystemRole } from './system-role.ts';

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
  // Profile override wins; otherwise the registered lexicon default.
  const continueSys = req.continueFrom
    ? lexiconText('continue.instruction', {}, profileTurnResumption(profile)?.continueInstruction)
    : '';
  return [systemFromProfile(profile, role), req.system, continueSys].filter(Boolean).join('\n\n');
}

export { resolveTurnSystemPrompt };
