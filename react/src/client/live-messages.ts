import type { TraceRecord, TurnEvent } from '../../../mod.ts';
import type { GateDecision, ToolGate } from '../../../src/kernel/mod.ts';
import { isRecord } from '../../../src/kernel/util/record.ts';

export type LiveServerEnvelope =
	| { type: 'ready'; profile?: string; sessionId?: string }
	| { type: 'events'; events: TurnEvent[] }
	/** A trace record the session wrote, from a relay that delivers its traces (the playground). */
	| { type: 'trace'; record: TraceRecord }
	/** The relay's error body (`error`, `errorKind`, `errorInternal`), read as a host error. */
	| { type: 'error'; body: Record<string, unknown> }
	/**
	 * The relay's answer to the browser's `executeTool`: the session settled the
	 * call (its tool events carry what happened), holds it on a gate, or refused
	 * the message (the relay's error body, read as a host error).
	 */
	| { type: 'executeToolResult'; callId: string; status: 'settled' }
	| { type: 'executeToolResult'; callId: string; status: 'gated'; gate: ToolGate }
	| { type: 'executeToolResult'; callId: string; status: 'refused'; body: Record<string, unknown> };

/** What the session did with an `executeTool`: settled the call, or holds it on a gate. */
export type LiveToolStep = { status: 'settled' } | { status: 'gated'; gate: ToolGate };

/**
 * Ask the relay to run `LiveSession.executeTool` for a call the model made.
 * `decision` answers its gate; `input` is the user's edit to an approval;
 * `secret` is the key the user typed at a sign-in gate, sent once: the
 * session makes it the credential for the gate's slot.
 */
export type ExecuteToolOnRelay = (args: {
	callId: string;
	decision?: GateDecision;
	input?: unknown;
	secret?: string;
}) => Promise<LiveToolStep>;

function isTurnEvent(value: unknown): value is TurnEvent {
	return Boolean(value && typeof value === 'object' && 'type' in value);
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

function parseExecuteToolResult(record: Record<string, unknown>): LiveServerEnvelope | null {
	const { callId, status } = record;
	if (typeof callId !== 'string') return null;
	if (status === 'settled') return { type: 'executeToolResult', callId, status };
	if (status === 'gated' && isRecord(record.gate)) {
		return { type: 'executeToolResult', callId, status, gate: record.gate as unknown as ToolGate };
	}
	if (status === 'refused' && isRecord(record.body)) {
		return { type: 'executeToolResult', callId, status, body: record.body };
	}
	return null;
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
