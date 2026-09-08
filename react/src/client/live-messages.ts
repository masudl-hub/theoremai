import type { TurnEvent } from 'theorum';

export type LiveServerEnvelope =
	| { type: 'ready' }
	| { type: 'events'; events: TurnEvent[] }
	| { type: 'error'; error: string };

function isTurnEvent(value: unknown): value is TurnEvent {
	return Boolean(value && typeof value === 'object' && 'type' in value);
}

export function parseLiveServerEnvelope(raw: unknown): LiveServerEnvelope | null {
	if (!raw || typeof raw !== 'object') return null;
	const record = raw as Record<string, unknown>;
	switch (record.type) {
		case 'ready':
			return { type: 'ready' };
		case 'events':
			if (!Array.isArray(record.events)) return null;
			return {
				type: 'events',
				events: record.events.filter(isTurnEvent),
			};
		case 'error':
			return typeof record.error === 'string' ? { type: 'error', error: record.error } : null;
		default:
			return null;
	}
}
