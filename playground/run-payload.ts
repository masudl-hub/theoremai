/**
 * Playground → run-tab handoff via keyed localStorage + `?run=` URL id.
 *
 * @module
 */

import type { ProfileDefinition } from '../mod.ts';
import type { StructuredRegistration, ToolRegistration } from './registrations.ts';
import {
	clearPlaygroundRunPayloadRecord,
	createPlaygroundRunId,
	loadPlaygroundRunPayloadRecord,
	PLAYGROUND_RUN_INDEX_KEY,
	PLAYGROUND_RUN_PAYLOAD_CAP,
	PLAYGROUND_RUN_PAYLOAD_KEY,
	PLAYGROUND_RUN_PAYLOAD_KEY_PREFIX,
	type PlaygroundRunIndex,
	type PlaygroundRunIndexEntry,
	playgroundRunPayloadKey,
	readPlaygroundRunIdFromUrl,
	savePlaygroundRunPayloadRecord,
	upsertPlaygroundRunIndex,
} from './run-payload-core.ts';

export {
	createPlaygroundRunId,
	PLAYGROUND_RUN_INDEX_KEY,
	PLAYGROUND_RUN_PAYLOAD_CAP,
	PLAYGROUND_RUN_PAYLOAD_KEY,
	PLAYGROUND_RUN_PAYLOAD_KEY_PREFIX,
	type PlaygroundRunIndex,
	type PlaygroundRunIndexEntry,
	playgroundRunPayloadKey,
	readPlaygroundRunIdFromUrl,
	upsertPlaygroundRunIndex,
};

export type PlaygroundRunPayload = {
	/** Payload schema version — bump when handoff shape changes. */
	version?: 1;
	/** Optional echo of the storage/URL run id. */
	runId?: string;
	agentId: string;
	profile: ProfileDefinition;
	customTools: ToolRegistration[];
	structured?: StructuredRegistration;
};

/**
 * Persist compiled agent for the run tab. Uses `localStorage` (not `sessionStorage`)
 * so `window.open` handoffs work — session storage is per-tab only.
 */
export function savePlaygroundRunPayload(
	payload: PlaygroundRunPayload,
	runId: string,
	storeOverride?: Storage | null,
): void {
	savePlaygroundRunPayloadRecord({ ...payload } as Record<string, unknown>, runId, storeOverride);
}

export function loadPlaygroundRunPayload(
	runId: string,
	storeOverride?: Storage | null,
): PlaygroundRunPayload | null {
	const raw = loadPlaygroundRunPayloadRecord(runId, storeOverride);
	if (!raw) return null;
	return raw as unknown as PlaygroundRunPayload;
}

export function clearPlaygroundRunPayload(
	runId: string,
	storeOverride?: Storage | null,
): void {
	clearPlaygroundRunPayloadRecord(runId, storeOverride);
}
