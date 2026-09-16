import type { ToolGate } from 'theorum/kernel';

export type LiveToolGatePrompt = {
	toolName: string;
	input: Record<string, unknown>;
	gate: ToolGate;
};
