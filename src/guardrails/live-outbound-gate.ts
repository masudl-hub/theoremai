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

import type { Profile, ProfileEgressSpec, TurnEvent } from '../kernel/types.ts';
import { eventHasCanary, isStreamedCanaryEvent } from './canary.ts';
import { PUBLIC_CANARY } from './error.ts';
import { createOutboundProgressiveGate, type ProgressiveYieldGate } from './progressive-yield.ts';

export interface LiveOutboundGateSession {
  profile: Profile;
  canary?: string;
  gate: ProgressiveYieldGate | null;
  lastStreamType?: 'text' | 'thought';
  /** Stop releasing host-visible text/thought after a progressive egress hit. */
  withholdVisible: boolean;
}

export type LiveOutboundBatchResult =
  | { action: 'emit'; events: TurnEvent[] }
  | { action: 'withhold'; error: string }
  | { action: 'idle' };

function egressSpec(profile: Profile): ProfileEgressSpec | undefined {
  return profile.guardrails?.egress;
}

function createLiveOutboundGateSession(profile: Profile, canary?: string): LiveOutboundGateSession {
  const useCanary = profile.guardrails?.canary === true && Boolean(canary);
  const resolvedCanary = useCanary ? canary : undefined;
  return {
    profile,
    canary: resolvedCanary,
    gate: createOutboundProgressiveGate(profile, resolvedCanary),
    withholdVisible: false,
  };
}

/** Canary-only profiles stop the turn immediately; egress profiles defer to finalize. */
function canaryOnlyImmediateWithhold(session: LiveOutboundGateSession): boolean {
  return !egressSpec(session.profile)?.enforce;
}

function armEgressWithhold(session: LiveOutboundGateSession): void {
  session.withholdVisible = true;
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
      return { action: 'withhold', error: PUBLIC_CANARY };
    }
    armEgressWithhold(session);
    return { action: 'idle' };
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
      return { action: 'withhold', error: PUBLIC_CANARY };
    }
    armEgressWithhold(session);
    return prior.length ? { action: 'emit', events: prior } : { action: 'idle' };
  }
  if (result.emit) {
    prior.push({ ...event, text: result.emit });
  }
  return prior.length ? { action: 'emit', events: prior } : { action: 'idle' };
}

function scanNonStreamEvent(session: LiveOutboundGateSession, event: TurnEvent): boolean {
  return Boolean(session.canary && eventHasCanary(event, session.canary));
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
      return { action: 'withhold', error: PUBLIC_CANARY };
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

async function finalizeLiveOutboundTurn(
  session: LiveOutboundGateSession,
): Promise<LiveOutboundBatchResult> {
  const extra: TurnEvent[] = [];

  const withheld = await flushProgressiveTailInto(session, extra);
  if (withheld) {
    return withheld;
  }

  const egress = egressSpec(session.profile);
  const accumulated = session.gate?.accumulated() ?? '';

  if (session.withholdVisible || egress?.enforce) {
    if (!accumulated && !session.withholdVisible) {
      return extra.length ? { action: 'emit', events: extra } : { action: 'idle' };
    }

    if (egress?.enforce && accumulated) {
      const enforcement = await egress.enforce({
        text: accumulated,
        canary: session.canary,
        profile: session.profile,
      });

      if (enforcement.blocked) {
        if (egress.onBlock === 'refuse_to_user' && enforcement.text) {
          return { action: 'emit', events: [{ type: 'text', text: enforcement.text }] };
        }
        return { action: 'withhold', error: PUBLIC_CANARY };
      }
    } else if (session.withholdVisible) {
      return { action: 'withhold', error: PUBLIC_CANARY };
    }
  }

  if (extra.length === 0) {
    return { action: 'idle' };
  }
  return { action: 'emit', events: extra };
}

/** Drop progressive-yield state when the user interrupts mid-turn. */
function abortLiveOutboundTurn(session: LiveOutboundGateSession): void {
  session.lastStreamType = undefined;
  session.withholdVisible = false;
  session.gate = createOutboundProgressiveGate(session.profile, session.canary);
}

export {
  abortLiveOutboundTurn,
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  processLiveOutboundBatch,
};
