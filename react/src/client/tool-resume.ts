import type { ToolCredential, ToolPause, ToolPermission } from 'theorum/kernel';

export type ToolDecisionAction = 'allow' | 'allow_session' | 'deny';

export type ToolPauseResolution =
	| { action: 'deny' }
	| { action: ToolDecisionAction; interactiveValue?: unknown }
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

export function buildInvokeToolResume(
	pauseKind: ToolPause['kind'],
	interactiveValue?: unknown,
): InvokeToolResumeInput {
	if (pauseKind === 'interactive') {
		if (interactiveValue === undefined) {
			throw new Error('Interactive tool resume requires a chosen option.');
		}
		return { value: interactiveValue };
	}
	return { granted: true };
}

export type PausedToolContinue =
	| { kind: 'denied' }
	| { kind: 'auth'; credentials: Record<string, ToolCredential> }
	| {
			kind: 'continue';
			resume: InvokeToolResumeInput;
			sessionPermissions: string[];
	  };

export function continuePausedToolInvocation(args: {
	toolName: string;
	pause: Pick<ToolPause, 'kind' | 'permission'>;
	sessionPermissions: readonly string[];
	resolution: ToolPauseResolution;
}): PausedToolContinue {
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
			args.pause.permission,
		),
		resume: buildInvokeToolResume(args.pause.kind, args.resolution.interactiveValue),
	};
}
