import {
	clearStaleStudioRuns,
	loadStudioRunPayload,
	readStudioRunIdFromUrl,
	type StudioRunPayload,
} from '../../mod.ts';
import { type ProjectSession, projectSession } from './studio-project.ts';

/** What a run tab opens on: the compiled agent, and the project it belongs to if it has one. */
export type StudioRunOpened = { payload: StudioRunPayload; project: ProjectSession | null };

/**
 * What the run tab at `url` opens on, or `null` when its agent is gone. The compiled agent is kept
 * in this browser's storage under the id in the address, so this runs in the browser. `project`
 * says whether this host can have a project open; without it, the address's project is ignored.
 */
export function openStudioRun(url: string, options: { project: boolean }): StudioRunOpened | null {
	clearStaleStudioRuns();
	const runId = readStudioRunIdFromUrl(url);
	const payload = runId ? loadStudioRunPayload(runId) : null;
	if (!payload) return null;
	const name = options.project ? new URL(url).searchParams.get('project') : null;
	return { payload, project: name ? projectSession(name) : null };
}
