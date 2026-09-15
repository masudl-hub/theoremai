import type { ToolCredential, ToolGate, ToolPermission } from 'theorum/kernel';

export type ToolDecisionAction = 'allow' | 'allow_session' | 'deny';

export type ToolGateResolution =
	| { action: 'deny' }
	| { action: ToolDecisionAction }
	| { action: 'auth'; credentials: Record<string, ToolCredential> };

export type InvokeToolResumeInput = {
	value?: unknown;
	granted?: boolean;
};

export function applyToolDecisionToSessionPermissions(
	sessionPermissions: readonly string[],
	toolName: string,
	action: ToolDecisionAction,
	permission?: ToolPermission,
): string[] {
	let next = [...sessionPermissions];
	if (action === 'allow_session' && !next.includes(toolName)) {
		next = [...next, toolName];
	}
	if (action === 'allow' && permission === 'session_consent') {
		next = [...new Set([...next, toolName])];
	}
	return next;
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
		sessionPermissions: applyToolDecisionToSessionPermissions(
			args.sessionPermissions,
			args.toolName,
			args.resolution.action,
			args.gate.permission,
		),
		resume: buildInvokeToolResume(args.gate.kind),
	};
}
