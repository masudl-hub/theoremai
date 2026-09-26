/**
 * How a gate (permission, confirmation, sign-in) is answered: how long it
 * waits, what each decision resumes the call with, and what an approval
 * leaves the session allowed. Shared by `createTheoremHandler` and `runSession`.
 *
 * @module
 */

import { TheoremError } from '../../guardrails/error.ts';
import type { ToolPermission } from '../schema.ts';
import type { InvokeToolResume } from './types.ts';

/** A gate waits 30 minutes for its answer unless the host sets `gateTtlMs`. */
const DEFAULT_GATE_TTL_MS = 30 * 60 * 1000;

/**
 * The gate TTL `owner` runs with: `gateTtlMs`, or the default. A non-positive
 * or non-finite value is refused when `owner` is built, not when a gate expires.
 */
export function resolveGateTtlMs(owner: string, gateTtlMs: number | undefined): number {
  const ttl = gateTtlMs ?? DEFAULT_GATE_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new TheoremError(
      'config',
      `${owner} gateTtlMs must be a positive number of milliseconds; got ${ttl}.`, // lexicon-exempt: builder config error at setup; no user sees it
    );
  }
  return ttl;
}

/** Whether a gate opened at `createdAt` has waited past `ttlMs` at `now`. */
export function gateExpired(createdAt: number, now: number, ttlMs: number): boolean {
  return now - createdAt >= ttlMs;
}

/** The user's answer to a gate: run it, refuse it, or walk away from it. */
export const GATE_DECISIONS = ['approve', 'deny', 'abandon'] as const;
export type GateDecision = (typeof GATE_DECISIONS)[number];

/**
 * A gate's answer. Only an approval takes an edit: `edited.from` is the input
 * the model proposed, when the user changed it before approving.
 */
export type GateAnswer =
  | { decision: 'approve'; edited?: { from: Record<string, unknown> } }
  | { decision: 'deny' | 'abandon' };

/** The resume an answer runs the gated call with. */
export function resumeForAnswer(answer: GateAnswer): InvokeToolResume {
  if (answer.decision === 'approve') {
    return answer.edited ? { granted: true, edited: answer.edited } : { granted: true };
  }
  return { granted: false, cause: answer.decision === 'deny' ? 'declined' : 'abandoned' };
}

/**
 * Session permissions after the user approves a gated call. The registrant's tier decides:
 * a `session_consent` approval lasts the session; any other gate is approved for this call only.
 */
export function sessionPermissionsAfterApproval(
  sessionPermissions: readonly string[],
  toolName: string,
  permission?: ToolPermission,
): string[] {
  if (permission !== 'session_consent' || sessionPermissions.includes(toolName)) {
    return [...sessionPermissions];
  }
  return [...sessionPermissions, toolName];
}
