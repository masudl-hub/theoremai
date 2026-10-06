import type { DecisionQuestion, ProfileDefinition } from '../mod.ts';
import type { PlaygroundConnectionMode } from './policy.ts';
import type { PlaygroundDependency } from './runtime-scope.ts';
import type { StructuredRegistration, ToolRegistration } from './registrations.ts';
import {
	clearPlaygroundRunPayloadRecord,
	createPlaygroundRunId,
	keptPlaygroundRunIds,
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
	keptPlaygroundRunIds,
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
  /** Execution choice only. Credentials never belong in this persisted payload. */
  connectionMode?: PlaygroundConnectionMode;
  /** Non-secret localhost connection setting; no bearer key travels with it. */
  localBaseUrl?: string;
	runId?: string;
	agentId: string;
	profile: ProfileDefinition;
	customTools: ToolRegistration[];
	structured?: StructuredRegistration;
	/** A decision profile's questions, by id. */
	questions?: Record<string, DecisionQuestion>;
	/** The agents this one names, each after the agents it names; registered before it. */
	dependencies?: PlaygroundDependency[];
};

/** `localStorage`, not `sessionStorage`: session storage is per-tab, so a `window.open` handoff would lose it. */
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
	storeOverride?: Storage | null): void {
	clearPlaygroundRunPayloadRecord(runId, storeOverride);
}
