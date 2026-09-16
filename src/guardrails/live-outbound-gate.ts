/**
 * Stateful Live outbound gate — progressive-yield canary + egress lookback.
 *
 * Matches runTurn semantics:
 *   • progressive-yield on text/thought deltas
 *   • canary-only profiles withhold immediately on leak (PUBLIC_CANARY)
 *   • with egress.enforce, mid-turn hits arm withhold; finalize refuse/withhold
 *   • media/tokens/tools pass through immediately (after non-stream canary scan)
 *
 * Live has no repair loop — blocked turns map to refuse_to_user copy or PUBLIC_CANARY.
 *
 * @module
 */

import type { Profile, TurnEvent } from '../kernel/types.ts';
import { eventHasCanary, isStreamedCanaryEvent } from './canary.ts';
import { EGRESS_RULES, runEnforcer } from './egress.ts';
import { PUBLIC_CANARY } from './error.ts';
import { guardrailFromHits, guardrailFromVerdict } from './events.ts';
import { resolveGuardrailPolicy } from './policy.ts';
import { createOutboundProgressiveGate, type ProgressiveYieldGate } from './progressive-yield.ts';
import type {
  GuardrailContext,
  GuardrailHit,
  ProfileEgressSpec,
  ResolvedGuardrailPolicy,
} from './types.ts';

export interface LiveOutboundGateSession {
  policy: ResolvedGuardrailPolicy;
  context: GuardrailContext;
  gate: ProgressiveYieldGate | null;
  lastStreamType?: 'text' | 'thought';
  /** Stop releasing host-visible text/thought after a progressive egress hit. */
  withholdVisible: boolean;
}

export type LiveOutboundBatchResult =
  | { action: 'emit'; events: TurnEvent[] }
  | { action: 'withhold'; error: string; events?: TurnEvent[] }
  | { action: 'idle' };

function egressSpec(session: LiveOutboundGateSession): ProfileEgressSpec | undefined {
  return session.policy.egress;
}

function createLiveOutboundGateSession(profile: Profile, canary?: string): LiveOutboundGateSession {
  const policy = resolveGuardrailPolicy(profile.guardrails);
  const useCanary = policy.canary && Boolean(canary);
  const context: GuardrailContext = {
    stage: 'live_outbound',
    trust: 'untrusted',
    profileId: profile.id,
    ...(useCanary ? { canary } : {}),
  };
  return {
    policy,
    context,
    gate: createOutboundProgressiveGate(policy, context),
    withholdVisible: false,
  };
}

/** Canary-only profiles stop the turn immediately; egress profiles defer to finalize. */
function canaryOnlyImmediateWithhold(session: LiveOutboundGateSession): boolean {
  return !egressSpec(session)?.enforce;
}

function armEgressWithhold(session: LiveOutboundGateSession): void {
  session.withholdVisible = true;
}

function canaryHit(): GuardrailHit[] {
  return [{ rule: EGRESS_RULES.canary, severity: 'high', match: '[canary]' }];
}

function withholdResult(
  error: string,
  hits: GuardrailHit[],
  prior: TurnEvent[] = [],
): LiveOutboundBatchResult {
  const guardrail = guardrailFromHits('live_outbound', 'untrusted', hits, 'block');
  return {
    action: 'withhold',
    error,
    events: [...prior, ...(guardrail ? [guardrail] : [])],
  };
}

async function flushProgressiveTail(
  session: LiveOutboundGateSession,
): Promise<LiveOutboundBatchResult> {
  if (!session.gate) {
    return { action: 'idle' };
  }
  const emitType = session.lastStreamType ?? 'text';
  const result = await session.gate.flush();
  session.lastStreamType = undefined;
  if (result.blocked) {
    if (canaryOnlyImmediateWithhold(session)) {
      return withholdResult(PUBLIC_CANARY, result.hits);
    }
    armEgressWithhold(session);
    const guardrail = guardrailFromHits('live_outbound', 'untrusted', result.hits, 'block');
    return guardrail ? { action: 'emit', events: [guardrail] } : { action: 'idle' };
  }
  if (!result.emit || session.withholdVisible) {
    return { action: 'idle' };
  }
  return { action: 'emit', events: [{ type: emitType, text: result.emit }] };
}

async function processStreamChunk(
  session: LiveOutboundGateSession,
  event: TurnEvent & { type: 'text' | 'thought' },
): Promise<LiveOutboundBatchResult> {
  if (!session.gate) {
    if (session.withholdVisible) {
      return { action: 'idle' };
    }
    return { action: 'emit', events: [event] };
  }

  if (session.withholdVisible) {
    // Keep feeding the gate so finalize sees full text for refuse/withhold.
    await session.gate.process(event.text ?? '');
    return { action: 'idle' };
  }

  const prior: TurnEvent[] = [];
  if (session.lastStreamType && session.lastStreamType !== event.type) {
    const tailResult = await flushProgressiveTail(session);
    if (tailResult.action === 'withhold') {
      return tailResult;
    }
    if (tailResult.action === 'emit') {
      prior.push(...tailResult.events);
    }
  }
  session.lastStreamType = event.type;

  const result = await session.gate.process(event.text ?? '');
  if (result.blocked) {
    if (canaryOnlyImmediateWithhold(session)) {
      return withholdResult(PUBLIC_CANARY, result.hits, prior);
    }
    armEgressWithhold(session);
    const guardrail = guardrailFromHits('live_outbound', 'untrusted', result.hits, 'block');
    if (guardrail) {
      prior.push(guardrail);
    }
    return prior.length ? { action: 'emit', events: prior } : { action: 'idle' };
  }
  if (result.emit) {
    prior.push({ ...event, text: result.emit });
  }
  return prior.length ? { action: 'emit', events: prior } : { action: 'idle' };
}

function scanNonStreamEvent(session: LiveOutboundGateSession, event: TurnEvent): boolean {
  const { canary } = session.context;
  return Boolean(canary && eventHasCanary(event, canary));
}

async function flushProgressiveTailInto(
  session: LiveOutboundGateSession,
  into: TurnEvent[],
): Promise<LiveOutboundBatchResult | undefined> {
  if (!(session.gate && session.lastStreamType)) {
    return undefined;
  }
  const tailResult = await flushProgressiveTail(session);
  if (tailResult.action === 'withhold') {
    return tailResult;
  }
  if (tailResult.action === 'emit') {
    into.push(...tailResult.events);
  }
  return undefined;
}

/** Process one upstream Live batch (may emit immediately or hold lookback). */
async function processLiveOutboundBatch(
  session: LiveOutboundGateSession,
  events: TurnEvent[],
): Promise<LiveOutboundBatchResult> {
  const toEmit: TurnEvent[] = [];

  for (const event of events) {
    if (isStreamedCanaryEvent(event)) {
      const streamResult = await processStreamChunk(
        session,
        event as TurnEvent & { type: 'text' | 'thought' },
      );
      if (streamResult.action === 'withhold') {
        return streamResult;
      }
      if (streamResult.action === 'emit') {
        toEmit.push(...streamResult.events);
      }
      continue;
    }

    const withheld = await flushProgressiveTailInto(session, toEmit);
    if (withheld) {
      return withheld;
    }

    if (scanNonStreamEvent(session, event)) {
      return withholdResult(PUBLIC_CANARY, canaryHit(), toEmit);
    }

    if (session.withholdVisible && (event.type === 'text' || event.type === 'thought')) {
      continue;
    }

    toEmit.push(event);
  }

  if (toEmit.length === 0) {
    return { action: 'idle' };
  }
  return { action: 'emit', events: toEmit };
}

function emitOrIdle(events: TurnEvent[]): LiveOutboundBatchResult {
  return events.length === 0 ? { action: 'idle' } : { action: 'emit', events };
}

function emitWithOptionalGuardrail(
  prior: TurnEvent[],
  guardrail: TurnEvent | undefined,
  text: string,
): LiveOutboundBatchResult {
  return {
    action: 'emit',
    events: [...prior, ...(guardrail ? [guardrail] : []), { type: 'text', text }],
  };
}

async function finalizeEgressEnforce(
  session: LiveOutboundGateSession,
  egress: ProfileEgressSpec,
  accumulated: string,
  prior: TurnEvent[],
): Promise<LiveOutboundBatchResult | undefined> {
  const verdict = await runEnforcer(egress.enforce, { text: accumulated }, session.context);
  const guardrail = guardrailFromVerdict('live_outbound', 'untrusted', verdict);

  if (verdict.action === 'redact') {
    return emitWithOptionalGuardrail(prior, guardrail, verdict.text);
  }
  if (verdict.action === 'block') {
    if (egress.onBlock === 'refuse_to_user' && verdict.refusal) {
      return emitWithOptionalGuardrail(prior, guardrail, verdict.refusal);
    }
    return withholdResult(PUBLIC_CANARY, verdict.hits, prior);
  }
  if (guardrail) {
    prior.push(guardrail);
  }
  return undefined;
}

async function finalizeLiveOutboundTurn(
  session: LiveOutboundGateSession,
): Promise<LiveOutboundBatchResult> {
  const extra: TurnEvent[] = [];

  const withheld = await flushProgressiveTailInto(session, extra);
  if (withheld) {
    return withheld;
  }

  const egress = egressSpec(session);
  const accumulated = session.gate?.accumulated() ?? '';

  if (!(session.withholdVisible || egress)) {
    return emitOrIdle(extra);
  }

  if (!accumulated && !session.withholdVisible) {
    return emitOrIdle(extra);
  }

  if (egress && accumulated) {
    const enforced = await finalizeEgressEnforce(session, egress, accumulated, extra);
    if (enforced) {
      return enforced;
    }
  } else if (session.withholdVisible) {
    return withholdResult(PUBLIC_CANARY, canaryHit(), extra);
  }

  return emitOrIdle(extra);
}

/** Drop progressive-yield state when the user interrupts mid-turn. */
function abortLiveOutboundTurn(session: LiveOutboundGateSession): void {
  session.lastStreamType = undefined;
  session.withholdVisible = false;
  session.gate = createOutboundProgressiveGate(session.policy, session.context);
}

export {
  abortLiveOutboundTurn,
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  processLiveOutboundBatch,
};
