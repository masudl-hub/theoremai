import type { ProfileDefinition } from 'theorum';
import type { StructuredRegistration, ToolRegistration } from './registrations';

export const PLAYGROUND_RUN_PAYLOAD_KEY = 'theorum.playground.run';

export type PlaygroundRunPayload = {
	/** Payload schema version — bump when handoff shape changes. */
	version?: 1;
	agentId: string;
	profile: ProfileDefinition;
	customTools: ToolRegistration[];
	structured?: StructuredRegistration;
};

/**
 * Persist compiled agent for the run tab. Uses `localStorage` (not `sessionStorage`)
 * so `window.open` handoffs work — session storage is per-tab only.
 */
function storage(): Storage | null {
	if (typeof window === 'undefined') return null;
	try {
		return localStorage;
	} catch {
		return null;
	}
}

export function savePlaygroundRunPayload(payload: PlaygroundRunPayload): void {
	const store = storage();
	if (!store) return;
	store.setItem(PLAYGROUND_RUN_PAYLOAD_KEY, JSON.stringify({ version: 1 as const, ...payload }));
}

export function loadPlaygroundRunPayload(): PlaygroundRunPayload | null {
	const store = storage();
	if (!store) return null;
	const raw = store.getItem(PLAYGROUND_RUN_PAYLOAD_KEY);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as PlaygroundRunPayload;
	} catch {
		return null;
	}
}

export function clearPlaygroundRunPayload(): void {
	const store = storage();
	if (!store) return;
	store.removeItem(PLAYGROUND_RUN_PAYLOAD_KEY);
}
