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
}): Promise<void> {
	const { client, name, toolArgs, callId } = args;
	let sessionPermissions = args.sessionPermissions;
	let step = await client.executeToolOnRelay({ callId });
	while (step.status === 'gated') {
		const { gate } = step;
		const resolution = await args.waitForGateDecision({ callId, toolName: name, input: toolArgs, gate });
		if (resolution === 'withdrawn') return;
		const reply = continueGatedToolInvocation({ toolName: name, gate, sessionPermissions, resolution });
		if (reply.decision === 'deny') {
			// The session settles the refusal; its tool event tells the user.
			await client.executeToolOnRelay({ callId, decision: 'deny' });
			return;
		}
		sessionPermissions = reply.sessionPermissions;
		args.setSessionPermissions(reply.sessionPermissions);
		// Signed in: a typed key goes once, with the approval; after an OAuth callback there is none.
		step = await client.executeToolOnRelay({
			callId,
			decision: 'approve',
			...(reply.secret !== undefined ? { secret: reply.secret } : {}),
		});
	}
}
