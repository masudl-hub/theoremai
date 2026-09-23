import type { ToolCredential, ToolGate, ToolPermission } from '../../../src/kernel/mod.ts';

export type ToolDecisionAction = 'allow' | 'deny';

export type ToolGateResolution =
	| { action: ToolDecisionAction }
	| { action: 'auth'; credentials: Record<string, ToolCredential> };

export type InvokeToolResumeInput = {
	value?: unknown;
	granted?: boolean;
};

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
	| { kind: 'auth'; credentials: Record<string, ToolCredential> }
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
		return { kind: 'auth', credentials: args.resolution.credentials };
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
