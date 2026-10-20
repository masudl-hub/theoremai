import type { TurnEvent } from '../kernel/types.ts';
import {
  type CanaryStreamGate,
  createCanaryStreamGate,
  eventHasCanary,
  guardedEventTexts,
  isStreamedCanaryEvent,
} from './canary.ts';
import { scanTextForPromptEcho } from './prompt-echo.ts';

/** A canary leak gate for one reply: the turn canary, the system prompt to catch echoes of, and the stream gate that holds text back. */
export interface CanaryGateSession {
  canary: string;
  /** The system prompt as sent, when replies echoing it are leaks too. */
  privateSystem?: readonly string[];
  gate: CanaryStreamGate;
}

/** Pass the system prompt as sent to catch replies that echo it, as `runTurn` and Live do. */
function createCanaryGateSession(
  canary: string,
  privateSystem?: readonly string[],
): CanaryGateSession {
  return {
    canary,
    ...(privateSystem ? { privateSystem } : {}),
    gate: createCanaryStreamGate(canary, privateSystem),
  };
}

function echoesPrompt(
  event: TurnEvent,
  canary: string,
  privateSystem?: readonly string[],
): boolean {
  return (
    privateSystem !== undefined &&
    guardedEventTexts(event).some((text) => scanTextForPromptEcho(text, privateSystem, canary))
  );
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
    if (
      eventHasCanary(event, session.canary) ||
      echoesPrompt(event, session.canary, session.privateSystem)
    ) {
      return { leaked: true };
    }
    out.push(event);
  }
  return { leaked: false, events: out };
}

export { createCanaryGateSession, filterCanaryGatedEvents };
