import { lexiconText } from 'theorum';
import type { LiveSessionClient } from '../../client/live-client';
import type { LiveToolGatePrompt } from '../../client/live/live-tool';
import { continueGatedToolInvocation, type ToolGateResolution } from '../../client/tool-resume';

function asOutputRecord(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return fallback;
}

async function settleDeniedTool(args: {
	client: LiveSessionClient;
	name: string;
	callId: string;
	input: Record<string, unknown>;
	message: string;
	setError: (message: string) => void;
}): Promise<Record<string, unknown>> {
	const settled = await args.client.executeToolOnRelay({
		name: args.name,
		callId: args.callId,
		input: args.input,
		resume: { granted: false },
	});
	const output = asOutputRecord(settled.output, { error: args.message });
	args.setError(args.message);
	return 'error' in output ? output : { ...output, error: args.message };
}

type LiveToolLoopState = {
	resume: { granted?: boolean } | undefined;
	credentials: Record<string, unknown> | undefined;
	sessionPermissions: string[];
};

async function advanceLiveToolGate(args: {
	client: LiveSessionClient;
	name: string;
	toolArgs: Record<string, unknown>;
	callId: string;
	gate: NonNullable<Awaited<ReturnType<LiveSessionClient['executeToolOnRelay']>>['gate']>;
	state: LiveToolLoopState;
	waitForGateDecision: (prompt: LiveToolGatePrompt) => Promise<ToolGateResolution>;
	setSessionPermissions: (next: string[]) => void;
	setError: (message: string) => void;
}): Promise<{ done: true; output: Record<string, unknown> } | { done: false; state: LiveToolLoopState }> {
	const resolution = await args.waitForGateDecision({
		toolName: args.name,
		input: args.toolArgs,
		gate: args.gate,
	});
	const next = continueGatedToolInvocation({
		toolName: args.name,
		gate: args.gate,
		sessionPermissions: args.state.sessionPermissions,
		resolution,
	});
	if (next.kind === 'denied') {
		return {
			done: true,
			output: await settleDeniedTool({
				client: args.client,
				name: args.name,
				callId: args.callId,
				input: args.toolArgs,
				message: lexiconText('session.tool_denied', { tool: args.name }),
				setError: args.setError,
			}),
		};
	}
	if (next.kind === 'auth') {
		return {
			done: false,
			state: {
				...args.state,
				credentials: { ...args.state.credentials, ...next.credentials },
				resume: undefined,
			},
		};
	}
	args.setSessionPermissions(next.sessionPermissions);
	return {
		done: false,
		state: {
			sessionPermissions: next.sessionPermissions,
			resume: next.resume,
			credentials: undefined,
		},
	};
}

/**
 * Live provider tool-call handler: execute on relay, pause for gates, resume.
 */
export async function runLiveToolCall(args: {
	client: LiveSessionClient;
	name: string;
	toolArgs: Record<string, unknown>;
	callId: string;
	sessionPermissions: string[];
	setSessionPermissions: (next: string[]) => void;
	waitForGateDecision: (prompt: LiveToolGatePrompt) => Promise<ToolGateResolution>;
	setError: (message: string) => void;
}): Promise<Record<string, unknown>> {
	const { client, name, toolArgs, callId, waitForGateDecision, setError, setSessionPermissions } =
		args;
	let state: LiveToolLoopState = {
		resume: undefined,
		credentials: undefined,
		sessionPermissions: args.sessionPermissions,
	};

	for (;;) {
		const result = await client.executeToolOnRelay({
			name,
			callId,
			input: toolArgs,
			resume: state.resume,
			credentials: state.credentials,
		});
		if (result.status === 'complete') {
			const output = asOutputRecord(result.output, { result: result.output });
			const outputError = typeof output.error === 'string' ? output.error : undefined;
			if (outputError) setError(outputError);
			return output;
		}
		if (!result.gate) {
			return settleDeniedTool({
				client,
				name,
				callId,
				input: toolArgs,
				message: `Tool gated without gate payload for '${name}'.`,
				setError,
			});
		}
		const stepped = await advanceLiveToolGate({
			client,
			name,
			toolArgs,
			callId,
			gate: result.gate,
			state,
			waitForGateDecision,
			setSessionPermissions,
			setError,
		});
		if (stepped.done) return stepped.output;
		state = stepped.state;
	}
}
