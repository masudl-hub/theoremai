/**
 * Live realtime inbound text — same sanitize + user_data fence as runTurn ingress.
 *
 * @module
 */

import { wrapUserData } from '../../guardrails/canary.ts';
import { guardrailFromHits, projectGuardrailTurnEvent } from '../../guardrails/events.ts';
import { detectionForTrust, resolveGuardrailPolicy } from '../../guardrails/policy.ts';
import { detectText } from '../../guardrails/sanitize.ts';
import { resolveObservabilityPolicy } from '../../observability/resolve-policy.ts';
import type { Profile, TurnEvent } from '../types.ts';

export interface LiveInboundPrepareResult {
  text: string;
  /** Present when inbound sanitize redacted spans. */
  guardrail?: TurnEvent;
}

/**
 * Sanitize profile-controlled inbound text and wrap with user_data fencing.
 *
 * Resolves through the shared policy so Live ingress and the turn engine cannot
 * drift apart on what an unset switch means. Returns an optional guardrail event
 * for the session stream when redaction ran. Match previews follow
 * `observability.include.guardrailMatchPreview`.
 */
function prepareLiveInboundText(profile: Profile, text: string): LiveInboundPrepareResult {
  const policy = resolveGuardrailPolicy(profile.guardrails);
  const detected = detectText(text, detectionForTrust(policy, 'untrusted'));
  const raw = guardrailFromHits('live_inbound', 'untrusted', detected.hits, 'redact');
  const includeMatch = resolveObservabilityPolicy(profile.observability).include
    .guardrailMatchPreview;
  const guardrail = raw ? projectGuardrailTurnEvent(raw, includeMatch) : undefined;
  return {
    text: wrapUserData(detected.text),
    ...(guardrail ? { guardrail } : {}),
  };
}

export { prepareLiveInboundText };
