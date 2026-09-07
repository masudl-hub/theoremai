/**
 * Live realtime inbound text — same sanitize + user_data fence as runTurn ingress.
 *
 * @module
 */

import { wrapUserData } from '../../guardrails/canary.ts';
import { sanitizeText } from '../../guardrails/sanitize.ts';
import type { Profile } from '../types.ts';

/** Sanitize profile-controlled inbound text and wrap with user_data fencing. */
function prepareLiveInboundText(profile: Profile, text: string): string {
  const guardrails = profile.guardrails;
  const safe = sanitizeText(text, {
    sanitizeInput: guardrails?.sanitizeInput === true,
    redactSensitive: guardrails?.redactSensitive === true,
  });
  return wrapUserData(safe);
}

export { prepareLiveInboundText };
