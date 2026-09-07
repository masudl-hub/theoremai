/**
 * Stateful canary gate for batched Live relay events (same semantics as runTurn stream).
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

export interface CanaryGateSession {
  canary: string;
  gate: CanaryStreamGate;
  lastStreamType?: 'text' | 'thought';
}

function createCanaryGateSession(canary: string): CanaryGateSession {
  return { canary, gate: createCanaryStreamGate(canary) };
}

function filterCanaryGatedEvents(
  session: CanaryGateSession,
  events: TurnEvent[],
): { leaked: true } | { leaked: false; events: TurnEvent[] } {
  const out: TurnEvent[] = [];
  for (const event of events) {
    if (isStreamedCanaryEvent(event)) {
      session.lastStreamType = event.type;
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
