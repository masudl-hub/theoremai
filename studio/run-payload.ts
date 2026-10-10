import type { DecisionQuestion, ProfileDefinition } from '../mod.ts';
import type { StudioConnectionMode } from './policy.ts';
import type { StudioDependency } from './runtime-scope.ts';
import type { StructuredRegistration, ToolRegistration } from './registrations.ts';
import {
	clearStudioRunPayloadRecord,
	createStudioRunId,
	keptStudioRunIds,
	loadStudioRunPayloadRecord,
	STUDIO_RUN_INDEX_KEY,
	STUDIO_RUN_PAYLOAD_CAP,
	STUDIO_RUN_PAYLOAD_KEY,
	STUDIO_RUN_PAYLOAD_KEY_PREFIX,
	type StudioRunIndex,
	type StudioRunIndexEntry,
	studioRunPayloadKey,
	readStudioRunIdFromUrl,
	saveStudioRunPayloadRecord,
	upsertStudioRunIndex,
} from './run-payload-core.ts';

export {
	createStudioRunId,
	keptStudioRunIds,
	STUDIO_RUN_INDEX_KEY,
	STUDIO_RUN_PAYLOAD_CAP,
	STUDIO_RUN_PAYLOAD_KEY,
	STUDIO_RUN_PAYLOAD_KEY_PREFIX,
	type StudioRunIndex,
	type StudioRunIndexEntry,
	studioRunPayloadKey,
	readStudioRunIdFromUrl,
	upsertStudioRunIndex,
};

export type StudioRunPayload = {
	/** Payload schema version — bump when handoff shape changes. */
	version?: 1;
  /** Execution choice only. Credentials never belong in this persisted payload. */
  connectionMode?: StudioConnectionMode;
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
	dependencies?: StudioDependency[];
};

/** `localStorage`, not `sessionStorage`: session storage is per-tab, so a `window.open` handoff would lose it. */
export function saveStudioRunPayload(
	payload: StudioRunPayload,
	runId: string,
	storeOverride?: Storage | null,
): void {
	saveStudioRunPayloadRecord({ ...payload } as Record<string, unknown>, runId, storeOverride);
}

export function loadStudioRunPayload(
	runId: string,
	storeOverride?: Storage | null,
): StudioRunPayload | null {
	const raw = loadStudioRunPayloadRecord(runId, storeOverride);
	if (!raw) return null;
	return raw as unknown as StudioRunPayload;
}

export function clearStudioRunPayload(
	runId: string,
	storeOverride?: Storage | null): void {
	clearStudioRunPayloadRecord(runId, storeOverride);
}
