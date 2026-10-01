import { detectionForTrust, resolveGuardrailPolicy } from '../../guardrails/policy.ts';
import { sanitizeText } from '../../guardrails/sanitize.ts';
import type { ModelProfile, TurnRequest } from '../types.ts';
import { pickSystemRole } from './system-role.ts';

/**
 * Routed through the policy at `trust: 'trusted'` so the exemption is declared where it applies,
 * not implied by skipping the sanitizer. `req.system` is `assembled` per turn and not exempt.
 */
function systemFromProfile(profile: ModelProfile, role: string): string {
  if (profile.type === 'speech') {
    return '';
  }
  const { systemByRole, system } = profile.identity;
  const text = systemByRole?.[role] || system || '';
  if (!text) {
    return '';
  }
  const policy = resolveGuardrailPolicy(profile.guardrails);
  return sanitizeText(text, detectionForTrust(policy, 'trusted'));
}

/** Synchronous: snapshotted in `resolveTurn` before any async work. */
function resolveTurnSystemPrompt(profile: ModelProfile, req: TurnRequest): string {
  const role = pickSystemRole(profile, req.input?.role);
  return [systemFromProfile(profile, role), req.system].filter(Boolean).join('\n\n');
}

export { resolveTurnSystemPrompt };
