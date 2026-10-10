import type { ToolGate } from '@theoremjs/agents/kernel';
import { sessionPermissionsAfterApproval } from '@theoremjs/agents/kernel';

export type ToolDecisionAction = 'allow' | 'deny';

export type ToolGateResolution =
  | { action: ToolDecisionAction }
  /** Signed in: `secret` is a key the user typed; after an OAuth callback there is none. */
  | { action: 'auth'; secret?: string }
  /** The page answered a `page` gate: no person decides it. */
  | { action: 'page'; page: PagePart };

/** What the page sends for a call it was asked to answer: its output, or that nothing here answers the tool. */
export type PagePart = { output: unknown } | { unanswered: true };

/** An answer on its way to the gate on `callId`; the gate shows it until the answer settles or fails. */
export type AnsweringGate = { callId: string; action: PersonGateResolution['action'] };

/** An answer a person gives: every resolution but the page's own. */
export type PersonGateResolution = Exclude<ToolGateResolution, { action: 'page' }>;

/**
 * What the browser sends for the user's answer to a gate. The host settles a
 * refusal; an approval carries the permissions the session holds after it,
 * by the rule the host applies (`sessionPermissionsAfterApproval`).
 */
export type GatedToolContinue =
  | { decision: 'deny' }
  | { decision: 'approve'; secret?: string; page?: PagePart; sessionPermissions: string[] };

export function continueGatedToolInvocation(args: {
  toolName: string;
  gate: Pick<ToolGate, 'permission'>;
  sessionPermissions: readonly string[];
  resolution: ToolGateResolution;
}): GatedToolContinue {
  if (args.resolution.action === 'deny') return { decision: 'deny' };
  const { resolution } = args;
  return {
    decision: 'approve',
    ...(resolution.action === 'auth' && resolution.secret !== undefined
      ? { secret: resolution.secret }
      : {}),
    ...(resolution.action === 'page' ? { page: resolution.page } : {}),
    sessionPermissions: sessionPermissionsAfterApproval(
      args.sessionPermissions,
      args.toolName,
      args.gate.permission,
    ),
  };
}
