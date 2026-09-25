import { type LexiconOverrides, lexiconText, TheoremError } from '../../../../mod.ts';
import type { LiveSessionClient } from '../../client/live-client';
import type { LiveToolGatePrompt } from '../../client/live/live-tool';
import { continueGatedToolInvocation, type ToolGateResolution } from '../../client/tool-resume';

function asOutputRecord(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return fallback;
}

/**
 * Settle a gated call as denied on the relay. The user reads `failure`; the
 * model reads the relay's output, else the lexicon's `session.tool_denied`.
 */
async function settleDeniedTool(args: {
	client: LiveSessionClient;
	name: string;
	callId: string;
	input: Record<string, unknown>;
	failure: TheoremError;
	lexicon: LexiconOverrides;
	reportFailure: (err: unknown) => void;
}): Promise<Record<string, unknown>> {
	const settled = await args.client.executeToolOnRelay({
		name: args.name,
		callId: args.callId,
		input: args.input,
		resume: { granted: false },
	});
	const denied = lexiconText('session.tool_denied', { tool: args.name }, args.lexicon);
	const output = asOutputRecord(settled.output, { error: denied });
	args.reportFailure(args.failure);
	return 'error' in output ? output : { ...output, error: denied };
}

type LiveToolLoopState = {
	resume: { granted?: boolean } | undefined;
	/** A key the user just typed, sent on the next call only. */
	secret: string | undefined;
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
	lexicon: LexiconOverrides;
	reportFailure: (err: unknown) => void;
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
				failure: new TheoremError(
					'declined',
					// lexicon-exempt: internal diagnostic; the user reads session.tool_denied
					`user denied ${args.name}`,
					{ copy: { key: 'session.tool_denied', params: { tool: args.name } } },
				),
				lexicon: args.lexicon,
				reportFailure: args.reportFailure,
			}),
		};
	}
	if (next.kind === 'auth') {
		return {
			done: false,
			state: {
				...args.state,
				secret: next.secret,
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
			secret: undefined,
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
	/** The interface's `lexicon`: the profile's wording. */
	lexicon: LexiconOverrides;
	reportFailure: (err: unknown) => void;
}): Promise<Record<string, unknown>> {
	const { client, name, toolArgs, callId, waitForGateDecision, lexicon, reportFailure, setSessionPermissions } =
		args;
	let state: LiveToolLoopState = {
		resume: undefined,
		secret: undefined,
		sessionPermissions: args.sessionPermissions,
	};

	for (;;) {
		const result = await client.executeToolOnRelay({
			name,
			callId,
			input: toolArgs,
			resume: state.resume,
			secret: state.secret,
		});
		// A failed step reaches the user through its tool event; the output is the model's.
		if (result.status === 'complete') return asOutputRecord(result.output, { result: result.output });
		if (!result.gate) {
			return settleDeniedTool({
				client,
				name,
				callId,
				input: toolArgs,
				// lexicon-exempt: internal diagnostic; the user reads error.bad_response
				failure: new TheoremError('bad_response', `relay gated ${name} without a gate`),
				lexicon,
				reportFailure,
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
			lexicon,
			reportFailure,
		});
		if (stepped.done) return stepped.output;
		state = stepped.state;
	}
}
