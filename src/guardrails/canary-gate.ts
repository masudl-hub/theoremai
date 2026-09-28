import type { TurnEvent } from '../kernel/types.ts';
import {
  type CanaryStreamGate,
  createCanaryStreamGate,
  eventHasCanary,
  isStreamedCanaryEvent,
} from './canary.ts';

export interface CanaryGateSession {
  canary: string;
  gate: CanaryStreamGate;
}

function createCanaryGateSession(canary: string): CanaryGateSession {
  return { canary, gate: createCanaryStreamGate(canary) };
}

/**
 * Canary-only batch filter for hosts that need stream lookback without full egress. Stops at the
 * first leak, so no unsafe event is returned; thoughts are unguarded (`isGuardedOutput`).
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
