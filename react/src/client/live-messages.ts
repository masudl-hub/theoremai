import type { TraceRecord, TurnEvent } from '../../../mod.ts';
import type { ToolGate } from '../../../src/kernel/mod.ts';

export type LiveServerEnvelope =
	| { type: 'ready'; profile?: string; sessionId?: string }
	| { type: 'events'; events: TurnEvent[] }
	/** A trace record the session wrote, from a relay that delivers its traces (the playground). */
	| { type: 'trace'; record: TraceRecord }
	/** The relay's error body (`error`, `errorKind`, `errorInternal`), read as a host error. */
	| { type: 'error'; body: Record<string, unknown> }
	| {
			type: 'executeToolResult';
			callId: string;
			name: string;
			status: 'complete' | 'gated';
			output?: unknown;
			gate?: ToolGate;
			awaiting?: boolean;
			failure?: { code: string; message: string };
	  };

function isTurnEvent(value: unknown): value is TurnEvent {
	return Boolean(value && typeof value === 'object' && 'type' in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function parseReady(record: Record<string, unknown>): LiveServerEnvelope {
	return {
		type: 'ready',
		profile: optionalString(record.profile),
		sessionId: optionalString(record.sessionId),
	};
}

function parseEvents(record: Record<string, unknown>): LiveServerEnvelope | null {
	if (!Array.isArray(record.events)) return null;
	return { type: 'events', events: record.events.filter(isTurnEvent) };
}

function parseTrace(record: Record<string, unknown>): LiveServerEnvelope | null {
	const trace = record.record;
	if (!(isRecord(trace) && Array.isArray(trace.spans))) return null;
	return { type: 'trace', record: trace as unknown as TraceRecord };
}

function parseError(record: Record<string, unknown>): LiveServerEnvelope {
	return { type: 'error', body: record };
}

function parseToolFailure(
	value: unknown,
): { code: string; message: string } | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.code !== 'string' || typeof value.message !== 'string') return undefined;
	return { code: value.code, message: value.message };
}

function parseExecuteToolResult(record: Record<string, unknown>): LiveServerEnvelope | null {
	if (typeof record.callId !== 'string' || typeof record.name !== 'string') return null;
	if (record.status !== 'complete' && record.status !== 'gated') return null;
	return {
		type: 'executeToolResult',
		callId: record.callId,
		name: record.name,
		status: record.status,
		output: record.output,
		gate: isRecord(record.gate) ? (record.gate as unknown as ToolGate) : undefined,
		awaiting: typeof record.awaiting === 'boolean' ? record.awaiting : undefined,
		failure: parseToolFailure(record.failure),
	};
}

export function parseLiveServerEnvelope(raw: unknown): LiveServerEnvelope | null {
	if (!isRecord(raw) || typeof raw.type !== 'string') return null;
	switch (raw.type) {
		case 'ready':
			return parseReady(raw);
		case 'events':
			return parseEvents(raw);
		case 'trace':
			return parseTrace(raw);
		case 'error':
			return parseError(raw);
		case 'executeToolResult':
			return parseExecuteToolResult(raw);
		default:
			return null;
	}
}
