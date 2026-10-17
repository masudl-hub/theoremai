import { wrapContext, wrapUserData } from '../../guardrails/canary.ts';
import { boundaryReader, detectAt, detectEvent } from '../../guardrails/detect-at.ts';
import { guardrailTurnEvent, projectGuardrailTurnEvent } from '../../guardrails/events.ts';
import { resolveGuardrailPolicy } from '../../guardrails/policy.ts';
import { sanitizeContext } from '../../guardrails/sanitize.ts';
import { resolveObservabilityPolicy } from '../../observability/resolve-policy.ts';
import { CONTEXT_SENDERS } from '../schema.ts';
import type { TurnEventOf } from '../turn-events.ts';
import type { Profile, TurnContext } from '../types.ts';

export interface LiveInboundPrepareResult {
  /** The message to send, wrapped as user data. Absent when a match blocks: it does not reach the model. */
  text?: string;
  /** Present when a detector matched. */
  guardrail?: TurnEventOf<'guardrail'>;
}

// why: Resolves through the shared policy so Live ingress and the turn engine cannot drift on what an unset switch means.
/** Reads text a live session receives from the user at the `live_user` boundary, wraps what crosses as user data, and returns the guardrail event when something matched. */
function prepareLiveInboundText(profile: Profile, text: string): LiveInboundPrepareResult {
  const { detect } = resolveGuardrailPolicy(profile.guardrails);
  const detected = detectAt(text, 'live_user', detect);
  const event = detectEvent('live_user', detected);
  const includeMatch = resolveObservabilityPolicy(profile.observability).include
    .guardrailMatchPreview;
  const guardrail = event
    ? projectGuardrailTurnEvent(guardrailTurnEvent(event), includeMatch)
    : undefined;
  return {
    ...(detected.text === undefined ? {} : { text: wrapUserData(detected.text) }),
    ...(guardrail ? { guardrail } : {}),
  };
}

export interface LiveContextPrepareResult {
  /** Each package that crossed, in its sender's fence, the host's first. */
  texts: string[];
  /** One per package a detector matched in. */
  guardrails: TurnEventOf<'guardrail'>[];
}

/** Reads each sender's context at the `context` boundary, as a turn does. A package a match blocks does not reach the model. */
function prepareLiveContext(profile: Profile, context: TurnContext): LiveContextPrepareResult {
  const { detect } = resolveGuardrailPolicy(profile.guardrails);
  const includeMatch = resolveObservabilityPolicy(profile.observability).include
    .guardrailMatchPreview;
  const texts: string[] = [];
  const guardrails: TurnEventOf<'guardrail'>[] = [];
  for (const sender of [...CONTEXT_SENDERS].reverse()) {
    if (context[sender] === undefined) continue;
    const read = sanitizeContext({ [sender]: context[sender] }, () =>
      boundaryReader('context', detect),
    );
    for (const event of read.events) {
      guardrails.push(projectGuardrailTurnEvent(guardrailTurnEvent(event), includeMatch));
    }
    const text = read.context?.[sender];
    if (!read.blocked && typeof text === 'string') texts.push(wrapContext(sender, text));
  }
  return { texts, guardrails };
}

export { prepareLiveContext, prepareLiveInboundText };
