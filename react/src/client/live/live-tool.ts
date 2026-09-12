import type { ToolCredential, ToolGate } from 'theorum/kernel';
import {
	type PlaygroundLiveToolResult,
	parsePlaygroundLiveToolResult,
} from '../playground-tool-result';
import type { PlaygroundRunPayload } from '../run-payload';
import { continueGatedToolInvocation, type ToolGateResolution } from '../tool-resume';
import { postPlaygroundJson } from './live-session';

export type LiveToolGatePrompt = {
	toolName: string;
	input: Record<string, unknown>;
	gate: ToolGate;
};

/** @deprecated Use `LiveToolGatePrompt`. */
export type LiveToolPausePrompt = LiveToolGatePrompt & { pause: ToolGate };

export type LiveToolInvokeOptions = {
	resume?: { value?: unknown; granted?: boolean };
	sessionPermissions?: string[];
	credentials?: Record<string, ToolCredential>;
};

export async function runPlaygroundLiveTool(
	payload: PlaygroundRunPayload,
	name: string,
	args: Record<string, unknown>,
	options: LiveToolInvokeOptions = {},
): Promise<PlaygroundLiveToolResult> {
	const raw = await postPlaygroundJson<unknown>(
		'/api/playground/live/tool',
		{
			profile: payload.profile,
			customTools: payload.customTools,
			name,
			input: args,
			resume: options.resume,
			sessionPermissions: options.sessionPermissions,
			credentials: options.credentials,
		},
		'Live tool failed',
	);
	return parsePlaygroundLiveToolResult(raw);
}

export async function invokePlaygroundLiveTool(args: {
	payload: PlaygroundRunPayload;
	name: string;
	input: Record<string, unknown>;
	sessionPermissions: string[];
	onGate: (prompt: LiveToolGatePrompt) => Promise<ToolGateResolution>;
	/** @deprecated Use `onGate`. */
	onPause?: (prompt: LiveToolPausePrompt) => Promise<ToolGateResolution>;
}): Promise<{ output: Record<string, unknown>; sessionPermissions: string[] }> {
	let sessionPermissions = [...args.sessionPermissions];
	let credentials: Record<string, ToolCredential> | undefined;
	let resume: LiveToolInvokeOptions['resume'];

	const onGate =
		args.onGate ??
		(args.onPause
			? async (prompt: LiveToolGatePrompt) => {
					const onPause = args.onPause;
					if (!onPause) {
						throw new Error('invokePlaygroundLiveTool requires onGate');
					}
					return onPause({ ...prompt, pause: prompt.gate });
				}
			: undefined);

	if (!onGate) {
		throw new Error('invokePlaygroundLiveTool requires onGate');
	}

	for (;;) {
		const result = await runPlaygroundLiveTool(args.payload, args.name, args.input, {
			resume,
			sessionPermissions,
			credentials,
		});

		if (result.status === 'complete') {
			return { output: result.output, sessionPermissions };
		}

		const resolution = await onGate({
			toolName: args.name,
			input: args.input,
			gate: result.gate,
		});

		const next = continueGatedToolInvocation({
			toolName: args.name,
			gate: result.gate,
			sessionPermissions,
			resolution,
		});

		if (next.kind === 'denied') {
			return {
				output: { error: `User denied execution of '${args.name}'.` },
				sessionPermissions,
			};
		}

		if (next.kind === 'auth') {
			credentials = { ...credentials, ...next.credentials };
			resume = undefined;
			continue;
		}

		sessionPermissions = next.sessionPermissions;
		resume = next.resume;
	}
}
