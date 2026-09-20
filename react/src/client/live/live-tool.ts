import type { ToolGate } from '../../../../src/kernel/mod.ts';

export type LiveToolGatePrompt = {
	toolName: string;
	input: Record<string, unknown>;
	gate: ToolGate;
};
