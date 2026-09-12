import type { TurnEvent } from 'theorum';
import type { ToolGate } from 'theorum/kernel';

const GATE_KINDS = new Set<ToolGate['kind']>(['confirmation', 'permission', 'auth']);

export type PlaygroundLiveToolResult =
	| { status: 'complete'; output: Record<string, unknown> }
	| {
			status: 'gated';
			toolName: string;
			gate: ToolGate;
			input: Record<string, unknown>;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolGate(value: unknown): value is ToolGate {
	if (!isRecord(value)) return false;
	if (typeof value.kind !== 'string' || !GATE_KINDS.has(value.kind as ToolGate['kind'])) {
		return false;
	}
	return typeof value.tool === 'string';
}

export function toolInvokeResultFromEvents(
	events: readonly TurnEvent[],
	name: string,
	input: Record<string, unknown>,
): PlaygroundLiveToolResult {
	const errEv = events.find((event) => event.type === 'error');
	if (errEv?.error) {
		return { status: 'complete', output: { error: errEv.error } };
	}

	const tool = events.findLast((event) => event.type === 'tool' && event.tool?.name === name)?.tool;
	if (!tool) {
		return { status: 'complete', output: { error: 'Tool execution produced no result' } };
	}

	if (tool.phase === 'gate' && tool.gate) {
		return {
			status: 'gated',
			toolName: name,
			gate: tool.gate,
			input,
		};
	}

	// Legacy pause wire during dual-API window
	if (tool.phase === 'pause' && tool.pause) {
		const pause = tool.pause;
		const kind =
			pause.kind === 'interactive' ? 'confirmation' : (pause.kind as ToolGate['kind']);
		return {
			status: 'gated',
			toolName: name,
			gate: {
				kind,
				tool: pause.tool,
				permission: pause.permission,
				summary: pause.summary,
				authChallenge: pause.authChallenge,
			},
			input,
		};
	}

	if (tool.phase === 'error' && tool.failure) {
		return {
			status: 'complete',
			output: {
				error: tool.failure.message,
				code: tool.failure.code,
				...(tool.failure.details !== undefined ? { details: tool.failure.details } : {}),
			},
		};
	}

	if (tool.output !== undefined) {
		if (typeof tool.output === 'object' && tool.output !== null && !Array.isArray(tool.output)) {
			return { status: 'complete', output: tool.output as Record<string, unknown> };
		}
		return { status: 'complete', output: { result: tool.output } };
	}

	return { status: 'complete', output: { success: true } };
}

export function parsePlaygroundLiveToolResult(raw: unknown): PlaygroundLiveToolResult {
	if (!isRecord(raw)) {
		throw new Error('Invalid live tool response');
	}
	if (typeof raw.error === 'string') {
		throw new Error(raw.error);
	}
	if (raw.status === 'complete') {
		return {
			status: 'complete',
			output: isRecord(raw.output) ? raw.output : { success: true },
		};
	}
	if (
		(raw.status === 'gated' || raw.status === 'paused') &&
		typeof raw.toolName === 'string' &&
		isToolGate(raw.gate ?? raw.pause)
	) {
		const gate = (raw.gate ?? raw.pause) as ToolGate;
		return {
			status: 'gated',
			toolName: raw.toolName,
			gate,
			input: isRecord(raw.input) ? raw.input : {},
		};
	}
	throw new Error('Invalid live tool response');
}
