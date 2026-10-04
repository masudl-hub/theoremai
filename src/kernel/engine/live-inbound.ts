import { wrapUserData } from '../../guardrails/canary.ts';
import { guardrailFromHits, projectGuardrailTurnEvent } from '../../guardrails/events.ts';
import { detectionForTrust, resolveGuardrailPolicy } from '../../guardrails/policy.ts';
import { detectText } from '../../guardrails/sanitize.ts';
import { resolveObservabilityPolicy } from '../../observability/resolve-policy.ts';
import type { TurnEventOf } from '../turn-events.ts';
import type { Profile } from '../types.ts';

export interface LiveInboundPrepareResult {
  text: string;
  /** Present when inbound sanitize redacted spans. */
  guardrail?: TurnEventOf<'guardrail'>;
}

// Resolves through the shared policy so Live ingress and the turn engine cannot drift on what an unset switch means.
/** Prepares text a live session receives from the user: detects and redacts it as untrusted under the profile's guardrails, wraps the result as user data, and returns the guardrail event when something was found. */
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
