import {
  keptStudioRun,
  readStudioRunIdFromUrl,
  type StudioRunPayload,
  studioRunDefines,
} from '../../mod.ts';
import { type ProjectSession, projectSession } from './studio-project.ts';
import { isRecord, takeRun } from './studio-session.ts';

/**
 * What a run tab opens on: the compiled agent, and the project it belongs to if it has one.
 * `masked` when its tools' credentials were masked to keep it, so it asks the studio tab for them.
 */
export type StudioRunOpened = {
  payload: StudioRunPayload;
  masked: boolean;
  project: ProjectSession | null;
};

/**
 * What the run tab at `url` opens on, or `null` when its agent is gone or this package no longer
 * defines it. The studio tab hands the compiled agent to this tab through the browser's keep,
 * under the id in the address, so this runs in the browser. `project` says whether this host can
 * have a project open; without it, the address's project is ignored.
 */
export async function openStudioRun(
  url: string,
  options: { project: boolean },
): Promise<StudioRunOpened | null> {
  const runId = readStudioRunIdFromUrl(url);
  const kept = runId ? await takeRun(runId) : undefined;
  let record: unknown;
  try {
    record = kept === undefined ? undefined : JSON.parse(kept);
  } catch {
    return null;
  }
  const payload = isRecord(record) ? keptStudioRun(record.payload) : null;
  if (!isRecord(record) || !payload || !studioRunDefines(payload)) return null;
  const name = options.project ? new URL(url).searchParams.get('project') : null;
  return { payload, masked: record.masked === true, project: name ? projectSession(name) : null };
}
