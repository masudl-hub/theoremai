import { type ErrorKind, TheoremError } from '../../../guardrails/error.ts';
import { asRecord } from '../../../kernel/engine/record.ts';
import type { ModelEvent } from '../../../kernel/types.ts';
import { findLast } from '../../../kernel/util/find-last.ts';
import type { LiveTurnPhase } from '../../types.ts';
import { readLiveInteractionStatus } from './framing.ts';

/** RFC 6455 §7.4.1 close codes; any other code is `unavailable`. */
const CLOSE_KINDS: Readonly<Record<number, ErrorKind>> = {
  1006: 'network',
  1007: 'unsupported',
  1008: 'unsupported',
  1011: 'unavailable',
  1013: 'busy',
};

/**
 * Google refuses an over-quota Live key with code 1011 (`unavailable`) and a reason
 * ("You exceeded your current quota, …"); the reason is the only quota signal.
 */
const QUOTA_CLOSE_RE = /\bquota\b/i;

/**
 * A bad key closes setup with 1007 ("API key not valid. …"), which by code
 * reads as `unsupported`; like quota, the reason is the only signal.
 */
const AUTH_CLOSE_RE = /\bAPI key (?:not valid|expired)\b/i;

/** The kind a close's reason names, if any. */
function closeReasonKind(reason: string): ErrorKind | undefined {
  if (QUOTA_CLOSE_RE.test(reason)) return 'rate_limit';
  if (AUTH_CLOSE_RE.test(reason)) return 'auth';
  return undefined;
}

export function closeError(
  code: number,
  reason: string,
  during: 'setup' | 'session',
): TheoremError {
  return new TheoremError(
    closeReasonKind(reason) ?? CLOSE_KINDS[code] ?? 'unavailable',
    `Gemini Live WebSocket closed during ${during} (${code}: ${reason})`,
  );
}

export function goAwayIn(events: readonly ModelEvent[]): { timeLeftMs?: number } | undefined {
  const warning = findLast(
    events,
    (ev): ev is Extract<ModelEvent, { type: 'session' }> =>
      ev.type === 'session' && ev.session.kind === 'closing_soon',
  );
  return warning?.session.kind === 'closing_soon'
    ? { timeLeftMs: warning.session.timeLeftMs }
    : undefined;
}

/**
 * `interactionStatus`, when sent, is authoritative: `IN_PROGRESS` keeps the cycle
 * open across `turnComplete` (background reasoning or async tools may still
 * produce output). Without it, `turnComplete` is the boundary.
 */
export function turnPhaseFromMessage(
  message: Record<string, unknown>,
  events: ModelEvent[],
): LiveTurnPhase {
  const interrupted = events.some((ev) => ev.type === 'done' && ev.interrupted === true);
  if (interrupted) return 'abort';
  const status = readLiveInteractionStatus(message);
  if (status === 'IDLE') return 'complete';
  if (status === 'IN_PROGRESS') return 'streaming';
  if (asRecord(message.serverContent)?.turnComplete === true) return 'complete';
  return 'streaming';
}
