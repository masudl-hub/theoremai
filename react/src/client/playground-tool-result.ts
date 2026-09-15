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

function complete(output: Record<string, unknown>): PlaygroundLiveToolResult {
	return { status: 'complete', output };
}

function outputFromTool(tool: NonNullable<TurnEvent['tool']>): PlaygroundLiveToolResult {
	if (tool.phase === 'error' && tool.failure) {
		return complete({
			error: tool.failure.message,
			code: tool.failure.code,
			...(tool.failure.details !== undefined ? { details: tool.failure.details } : {}),
		});
	}
	if (tool.output === undefined) return complete({ success: true });
	if (isRecord(tool.output)) return complete(tool.output);
	return complete({ result: tool.output });
}

export function toolInvokeResultFromEvents(
	events: readonly TurnEvent[],
	name: string,
	input: Record<string, unknown>,
): PlaygroundLiveToolResult {
	const errEv = events.find((event) => event.type === 'error');
	if (errEv?.error) return complete({ error: errEv.error });

	const tool = events.findLast((event) => event.type === 'tool' && event.tool?.name === name)?.tool;
	if (!tool) return complete({ error: 'Tool execution produced no result' });

	if (tool.phase === 'gate' && tool.gate) {
		return { status: 'gated', toolName: name, gate: tool.gate, input };
	}
	return outputFromTool(tool);
}

function parseGatedResult(raw: Record<string, unknown>): PlaygroundLiveToolResult {
	if (typeof raw.toolName !== 'string' || !isToolGate(raw.gate)) {
		throw new Error('Invalid live tool response');
	}
	return {
		status: 'gated',
		toolName: raw.toolName,
		gate: raw.gate,
		input: isRecord(raw.input) ? raw.input : {},
	};
}

export function parsePlaygroundLiveToolResult(raw: unknown): PlaygroundLiveToolResult {
	if (!isRecord(raw)) throw new Error('Invalid live tool response');
	if (typeof raw.error === 'string') throw new Error(raw.error);
	if (raw.status === 'complete') {
		return complete(isRecord(raw.output) ? raw.output : { success: true });
	}
	if (raw.status === 'gated') return parseGatedResult(raw);
	throw new Error('Invalid live tool response');
}
