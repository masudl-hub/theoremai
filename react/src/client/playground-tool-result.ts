import type { TurnEvent } from 'theorum';
import type { ToolPause } from 'theorum/kernel';

const PAUSE_KINDS = new Set<ToolPause['kind']>([
	'interactive',
	'confirmation',
	'permission',
	'auth',
]);

export type PlaygroundLiveToolResult =
	| { status: 'complete'; output: Record<string, unknown> }
	| {
			status: 'paused';
			toolName: string;
			pause: ToolPause;
			input: Record<string, unknown>;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolPause(value: unknown): value is ToolPause {
	if (!isRecord(value)) return false;
	if (typeof value.kind !== 'string' || !PAUSE_KINDS.has(value.kind as ToolPause['kind'])) {
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

	if (tool.phase === 'pause' && tool.pause) {
		return {
			status: 'paused',
			toolName: name,
			pause: tool.pause,
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
	if (raw.status === 'paused' && typeof raw.toolName === 'string' && isToolPause(raw.pause)) {
		const pause = raw.pause;
		return {
			status: 'paused',
			toolName: raw.toolName,
			pause,
			input: isRecord(raw.input) ? raw.input : {},
		};
	}
	throw new Error('Invalid live tool response');
}
