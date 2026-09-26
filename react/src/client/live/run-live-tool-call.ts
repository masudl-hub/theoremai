import { TheoremError } from '../../../../mod.ts';
import type { ExecuteToolOnRelay } from '../live-messages.ts';
import type { LiveGateAnswer, LiveToolGatePrompt } from './live-tool.ts';
import { continueGatedToolInvocation } from '../tool-resume.ts';

/**
 * Live provider tool-call handler: run the model's call on the relay; at a
 * gate, ask the user and send their decision. The session answers the model
 * however the call ends; its tool events tell the user. A call the model
 * cancels while its gate is open is gone: nothing is sent.
 */
export async function runLiveToolCall(args: {
	client: { executeToolOnRelay: ExecuteToolOnRelay };
	name: string;
	toolArgs: Record<string, unknown>;
	callId: string;
	sessionPermissions: string[];
	setSessionPermissions: (next: string[]) => void;
	waitForGateDecision: (prompt: LiveToolGatePrompt) => Promise<LiveGateAnswer>;
	reportFailure: (err: unknown) => void;
}): Promise<void> {
	const { client, name, toolArgs, callId } = args;
	let sessionPermissions = args.sessionPermissions;
	let step = await client.executeToolOnRelay({ callId });
	while (step.status === 'gated') {
		const { gate } = step;
		const resolution = await args.waitForGateDecision({ callId, toolName: name, input: toolArgs, gate });
		if (resolution === 'withdrawn') return;
		const next = continueGatedToolInvocation({ toolName: name, gate, sessionPermissions, resolution });
		if (next.kind === 'denied') {
			await client.executeToolOnRelay({ callId, decision: 'deny' });
			args.reportFailure(
				new TheoremError(
					'declined',
					// lexicon-exempt: internal diagnostic; the user reads session.tool_denied
					`user denied ${name}`,
					{ copy: { key: 'session.tool_denied', params: { tool: name } } },
				),
			);
			return;
		}
		if (next.kind === 'continue') {
			sessionPermissions = next.sessionPermissions;
			args.setSessionPermissions(next.sessionPermissions);
		}
		// Signed in: a typed key goes once, with the approval; after an OAuth callback there is none.
		const secret = next.kind === 'auth' ? next.secret : undefined;
		step = await client.executeToolOnRelay({
			callId,
			decision: 'approve',
			...(secret !== undefined ? { secret } : {}),
		});
	}
}
