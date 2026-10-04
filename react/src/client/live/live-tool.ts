import type { ToolGate } from '@theoremjs/agents/kernel';
import type { ToolGateResolution } from '../tool-resume.ts';

/** A gate the user is asked to answer, for the model's call `callId`. */
export type LiveToolGatePrompt = {
	callId: string;
	toolName: string;
	input: Record<string, unknown>;
	gate: ToolGate;
};

/** The user's answer to a live gate, or `withdrawn`: the model cancelled the call, so nothing is asked. */
export type LiveGateAnswer = ToolGateResolution | 'withdrawn';
