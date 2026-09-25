/**
 * Canary-only batch helper for hosts that need stream lookback without full
 * egress. Live production path: `live-outbound-gate.ts` (progressive yield).
 *
 * @module
 */

import type { TurnEvent } from '../kernel/types.ts';
import {
  type CanaryStreamGate,
  createCanaryStreamGate,
  eventHasCanary,
  isStreamedCanaryEvent,
} from './canary.ts';

/** Stateful canary scanner for an ordered sequence of turn events. */
export interface CanaryGateSession {
  canary: string;
  gate: CanaryStreamGate;
}

/** Creates a canary-only gate session for batched filtering of streamed and non-streamed events. */
function createCanaryGateSession(canary: string): CanaryGateSession {
  return { canary, gate: createCanaryStreamGate(canary) };
}

/**
 * Filters one event batch, withholding streamed overlap and reporting the first
 * canary leak before an unsafe event is returned to the caller. Only the reply
 * stream (`isStreamedCanaryEvent`) goes through the gate; thoughts are unguarded
 * (`isGuardedOutput`).
 */
function filterCanaryGatedEvents(
  session: CanaryGateSession,
  events: TurnEvent[],
): { leaked: true } | { leaked: false; events: TurnEvent[] } {
  const out: TurnEvent[] = [];
  for (const event of events) {
    if (isStreamedCanaryEvent(event)) {
      const result = session.gate.process(event.text ?? '');
      if (result.leak) {
        return { leaked: true };
      }
      if (result.emit) {
        out.push({ ...event, text: result.emit });
      }
      continue;
    }
    if (eventHasCanary(event, session.canary)) {
      return { leaked: true };
    }
    out.push(event);
  }
  return { leaked: false, events: out };
}

export { createCanaryGateSession, filterCanaryGatedEvents };
