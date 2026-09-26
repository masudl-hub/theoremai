import type { InvokeToolResume, ToolGate, ToolPermission } from '../../../src/kernel/mod.ts';

export type ToolDecisionAction = 'allow' | 'deny';

export type ToolGateResolution =
	| { action: ToolDecisionAction }
	/** Signed in: `secret` is a key the user typed; after an OAuth callback there is none. */
	| { action: 'auth'; secret?: string };

/** The part of `InvokeToolResume` the browser sends: the user's answer to a gate. */
export type InvokeToolResumeInput = Pick<InvokeToolResume, 'granted'>;

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

/** Gate resume always uses `granted: true` (ask_user answers are a new user turn). */
export function buildInvokeToolResume(_gateKind?: ToolGate['kind']): InvokeToolResumeInput {
	return { granted: true };
}

export type GatedToolContinue =
	| { kind: 'denied' }
	| { kind: 'auth'; secret?: string }
	| {
			kind: 'continue';
			resume: InvokeToolResumeInput;
			sessionPermissions: string[];
	  };

export function continueGatedToolInvocation(args: {
	toolName: string;
	gate: Pick<ToolGate, 'kind' | 'permission'>;
	sessionPermissions: readonly string[];
	resolution: ToolGateResolution;
}): GatedToolContinue {
	if (args.resolution.action === 'deny') {
		return { kind: 'denied' };
	}
	if (args.resolution.action === 'auth') {
		return { kind: 'auth', secret: args.resolution.secret };
	}

	return {
		kind: 'continue',
		sessionPermissions: sessionPermissionsAfterApproval(
			args.sessionPermissions,
			args.toolName,
			args.gate.permission,
		),
		resume: buildInvokeToolResume(args.gate.kind),
	};
}
