import type { DecisionAsset, DecisionQuestion, ProfileDefinition } from '@theoremjs/agents';
import { z } from 'zod';
import type { StudioConnectionMode } from './policy.ts';
import type { StudioProvider } from './providers.ts';
import type { StructuredRegistration, ToolRegistration } from './registrations.ts';
import {
  clearStudioRunPayloadRecord,
  createStudioRunId,
  keptStudioRunIds,
  loadStudioRunPayloadRecord,
  readStudioRunIdFromUrl,
  STUDIO_RUN_INDEX_KEY,
  STUDIO_RUN_PAYLOAD_CAP,
  STUDIO_RUN_PAYLOAD_KEY,
  STUDIO_RUN_PAYLOAD_KEY_PREFIX,
  type StudioRunIndex,
  type StudioRunIndexEntry,
  saveStudioRunPayloadRecord,
  studioRunPayloadKey,
  upsertStudioRunIndex,
} from './run-payload-core.ts';
import type { StudioDependency } from './runtime-scope.ts';

export {
  createStudioRunId,
  keptStudioRunIds,
  readStudioRunIdFromUrl,
  STUDIO_RUN_INDEX_KEY,
  STUDIO_RUN_PAYLOAD_CAP,
  STUDIO_RUN_PAYLOAD_KEY,
  STUDIO_RUN_PAYLOAD_KEY_PREFIX,
  type StudioRunIndex,
  type StudioRunIndexEntry,
  studioRunPayloadKey,
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
  /** The pictures every decision sends, by the reference its questions write. */
  images?: Record<string, DecisionAsset>;
  /** The providers its models name, each with its adapter. Left out, they are the studio's own. */
  providers?: readonly StudioProvider[];
  /** The agents this one names, each after the agents it names; registered before it. */
  dependencies?: StudioDependency[];
};

const kept = z.looseObject({
  profile: z.looseObject({ id: z.string() }),
  customTools: z.array(z.looseObject({ name: z.string() })),
});
/** The outline of a run kept in this browser, which an older or other package may have written. */
const keptRun = kept.extend({
  agentId: z.string(),
  dependencies: z.array(kept).optional(),
});

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
  // Only the outline is checked here; `defineProfile` checks the profiles when the run opens.
  if (!raw || !keptRun.safeParse(raw).success) return null;
  return raw as unknown as StudioRunPayload;
}

export function clearStudioRunPayload(runId: string, storeOverride?: Storage | null): void {
  clearStudioRunPayloadRecord(runId, storeOverride);
}
