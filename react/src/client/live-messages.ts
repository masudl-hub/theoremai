import type { TurnEvent } from 'theorum';
import type { ToolGate } from 'theorum/kernel';

export type LiveServerEnvelope =
	| { type: 'ready'; profile?: string; sessionId?: string }
	| { type: 'events'; events: TurnEvent[] }
	| { type: 'error'; error: string }
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

export function parseLiveServerEnvelope(raw: unknown): LiveServerEnvelope | null {
	if (!raw || typeof raw !== 'object') return null;
	const record = raw as Record<string, unknown>;
	switch (record.type) {
		case 'ready':
			return {
				type: 'ready',
				profile: typeof record.profile === 'string' ? record.profile : undefined,
				sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
			};
		case 'events':
			if (!Array.isArray(record.events)) return null;
			return {
				type: 'events',
				events: record.events.filter(isTurnEvent),
			};
		case 'error':
			return typeof record.error === 'string' ? { type: 'error', error: record.error } : null;
		case 'executeToolResult': {
			if (typeof record.callId !== 'string' || typeof record.name !== 'string') return null;
			const status =
				record.status === 'complete' || record.status === 'gated'
					? record.status
					: record.status === 'paused'
						? 'gated'
						: null;
			if (!status) return null;
			const gateSource = record.gate ?? record.pause;
			return {
				type: 'executeToolResult',
				callId: record.callId,
				name: record.name,
				status,
				output: record.output,
				gate: isRecord(gateSource) ? (gateSource as unknown as ToolGate) : undefined,
				awaiting: typeof record.awaiting === 'boolean' ? record.awaiting : undefined,
				failure: isRecord(record.failure)
					? (record.failure as { code: string; message: string })
					: undefined,
			};
		}
		default:
			return null;
	}
}
