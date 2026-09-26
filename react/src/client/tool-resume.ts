import type { ToolGate } from '../../../src/kernel/mod.ts';
import { sessionPermissionsAfterApproval } from '../../../src/kernel/tools/gate-answer.ts';

export type ToolDecisionAction = 'allow' | 'deny';

export type ToolGateResolution =
	| { action: ToolDecisionAction }
	/** Signed in: `secret` is a key the user typed; after an OAuth callback there is none. */
	| { action: 'auth'; secret?: string };

/**
 * What the browser sends for the user's answer to a gate. The host settles a
 * refusal; an approval carries the permissions the session holds after it,
 * by the rule the host applies (`sessionPermissionsAfterApproval`).
 */
export type GatedToolContinue =
	| { decision: 'deny' }
	| { decision: 'approve'; secret?: string; sessionPermissions: string[] };

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
		...(resolution.action === 'auth' && resolution.secret !== undefined ? { secret: resolution.secret } : {}),
		sessionPermissions: sessionPermissionsAfterApproval(
			args.sessionPermissions,
			args.toolName,
			args.gate.permission,
		),
	};
}
