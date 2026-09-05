/**
 * Stateful Live outbound gate — canary stream holdback + optional egress enforce.
 *
 * Matches runTurn semantics:
 *   • canary gate on text/thought deltas (streaming)
 *   • when egress.enforce is set, hold text/thought until turn end then evaluate
 *   • media/tokens/tools pass through immediately (after non-stream canary scan)
 *
 * Live has no repair loop — blocked turns map to refuse_to_user copy or PUBLIC_CANARY.
 *
 * @module
 */

import type { Profile, ProfileEgressSpec, TurnEvent } from '../kernel/types.ts';
import {
  type CanaryStreamGate,
  createCanaryStreamGate,
  eventHasCanary,
  isStreamedCanaryEvent,
} from './canary.ts';
import { PUBLIC_CANARY } from './error.ts';

export interface LiveOutboundGateSession {
  profile: Profile;
  canary?: string;
  gate: CanaryStreamGate | null;
  lastStreamType?: 'text' | 'thought';
  holdUserVisible: boolean;
  pendingVisible: TurnEvent[];
  accumulatedText: string;
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
  return {
    profile,
    canary: useCanary ? canary : undefined,
    gate: useCanary && canary ? createCanaryStreamGate(canary) : null,
    holdUserVisible: Boolean(egressSpec(profile)?.enforce),
    pendingVisible: [],
    accumulatedText: '',
  };
}

function appendVisibleText(session: LiveOutboundGateSession, event: TurnEvent): void {
  if (event.type !== 'text' && event.type !== 'thought') {
    return;
  }
  if (event.text) {
    session.accumulatedText += event.text;
  }
  session.pendingVisible.push(event);
}

function flushCanaryTail(session: LiveOutboundGateSession): LiveOutboundBatchResult {
  if (!session.gate) {
    return { action: 'idle' };
  }
  const emitType = session.lastStreamType ?? 'text';
  const tail = session.gate.flush();
  session.lastStreamType = undefined;
  if (tail.leak) {
    return { action: 'withhold', error: PUBLIC_CANARY };
  }
  if (!tail.emit) {
    return { action: 'idle' };
  }
  const event: TurnEvent = { type: emitType, text: tail.emit };
  if (session.holdUserVisible) {
    appendVisibleText(session, event);
    return { action: 'idle' };
  }
  return { action: 'emit', events: [event] };
}

function processStreamChunk(
  session: LiveOutboundGateSession,
  event: TurnEvent & { type: 'text' | 'thought' },
): LiveOutboundBatchResult {
  if (!session.gate) {
    if (session.holdUserVisible) {
      appendVisibleText(session, event);
      return { action: 'idle' };
    }
    return { action: 'emit', events: [event] };
  }

  if (session.lastStreamType && session.lastStreamType !== event.type) {
    const tailResult = flushCanaryTail(session);
    if (tailResult.action === 'withhold') {
      return tailResult;
    }
  }
  session.lastStreamType = event.type;

  const result = session.gate.process(event.text ?? '');
  if (result.leak) {
    return { action: 'withhold', error: PUBLIC_CANARY };
  }
  if (!result.emit) {
    return { action: 'idle' };
  }
  const gated: TurnEvent = { ...event, text: result.emit };
  if (session.holdUserVisible) {
    appendVisibleText(session, gated);
    return { action: 'idle' };
  }
  return { action: 'emit', events: [gated] };
}

function scanNonStreamEvent(session: LiveOutboundGateSession, event: TurnEvent): boolean {
  return Boolean(session.canary && eventHasCanary(event, session.canary));
}

function flushCanaryTailInto(
  session: LiveOutboundGateSession,
  into: TurnEvent[],
): LiveOutboundBatchResult | undefined {
  if (!(session.gate && session.lastStreamType)) {
    return undefined;
  }
  const tailResult = flushCanaryTail(session);
  if (tailResult.action === 'withhold') {
    return tailResult;
  }
  if (tailResult.action === 'emit') {
    into.push(...tailResult.events);
  }
  return undefined;
}

/** Process one upstream Live batch (may emit immediately or buffer for egress). */
function processLiveOutboundBatch(
  session: LiveOutboundGateSession,
  events: TurnEvent[],
): LiveOutboundBatchResult {
  const toEmit: TurnEvent[] = [];

  for (const event of events) {
    if (isStreamedCanaryEvent(event)) {
      const streamResult = processStreamChunk(
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

    const withheld = flushCanaryTailInto(session, toEmit);
    if (withheld) {
      return withheld;
    }

    if (scanNonStreamEvent(session, event)) {
      return { action: 'withhold', error: PUBLIC_CANARY };
    }

    if (session.holdUserVisible && (event.type === 'text' || event.type === 'thought')) {
      appendVisibleText(session, event);
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

  const withheld = flushCanaryTailInto(session, extra);
  if (withheld) {
    return withheld;
  }

  if (!session.holdUserVisible) {
    if (extra.length === 0) {
      return { action: 'idle' };
    }
    return { action: 'emit', events: extra };
  }

  if (session.pendingVisible.length === 0) {
    return extra.length ? { action: 'emit', events: extra } : { action: 'idle' };
  }

  const pending = session.pendingVisible;
  const text = session.accumulatedText;
  session.pendingVisible = [];
  session.accumulatedText = '';

  const egress = egressSpec(session.profile);
  if (!egress?.enforce) {
    return { action: 'emit', events: [...extra, ...pending] };
  }

  const enforcement = await egress.enforce({
    text,
    canary: session.canary,
    profile: session.profile,
  });

  if (!enforcement.blocked) {
    return { action: 'emit', events: [...extra, ...pending] };
  }

  if (egress.onBlock === 'refuse_to_user' && enforcement.text) {
    return { action: 'emit', events: [{ type: 'text', text: enforcement.text }] };
  }

  return { action: 'withhold', error: PUBLIC_CANARY };
}

/** Drop buffered assistant text when the user interrupts mid-turn. */
function abortLiveOutboundTurn(session: LiveOutboundGateSession): void {
  session.pendingVisible = [];
  session.accumulatedText = '';
  session.lastStreamType = undefined;
  if (session.canary) {
    session.gate = createCanaryStreamGate(session.canary);
  }
}

export {
  abortLiveOutboundTurn,
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  processLiveOutboundBatch,
};
