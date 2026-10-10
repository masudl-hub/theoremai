import { clearStaleStudioRuns, createExampleDraft, type StudioDraft, workspaceFromDraft } from '../../mod.ts';
import type { StudioOpened } from '../studio-host.ts';
import { openProject, type ProjectSession } from './studio-project.ts';
import { editsAside, restoreProject, restoreStudio } from './studio-restore.ts';
import { projectKey } from './studio-session.ts';

/**
 * What the studio opens on in this tab. Draft keys are random, so this runs in the browser. The
 * tab's kept workspace comes back unless a `seed` asks for another; then it waits behind Undo.
 */
export function openStudio(seed?: { draft: StudioDraft; question: string | undefined }): StudioOpened {
	clearStaleStudioRuns();
	const kept = restoreStudio();
	const fresh = (draft: StudioDraft) => ({
		workspace: workspaceFromDraft(draft),
		revision: kept.kind === 'restored' ? kept.value.revision + 1 : 0,
	});
	if (seed) {
		return {
			start: fresh(seed.draft),
			question: seed.question,
			displaced: kept.kind === 'restored' ? kept.value.workspace : undefined,
			discarded: kept.kind === 'discarded',
		};
	}
	if (kept.kind === 'restored')
		return { start: kept.value, question: undefined, displaced: undefined, discarded: false };
	return {
		start: fresh(createExampleDraft()),
		question: undefined,
		displaced: undefined,
		discarded: kept.kind === 'discarded',
	};
}

/**
 * What the studio opens on when a local server holds a project: the project's workspace, with the
 * edits this tab kept for it while its files are as they were. Edits whose files changed wait
 * behind an offer until the builder answers it. Closing the tab forgets them. Throws when no server answers.
 */
export async function openStudioProject(): Promise<StudioOpened & { project: ProjectSession }> {
	const { project, workspace } = await openProject();
	const key = projectKey(project.name);
	const kept = restoreProject(key, workspace, project.print);
	return {
		start:
			kept.kind === 'restored'
				? kept.value
				: { workspace, revision: 0, project: { key, files: project.print } },
		question: undefined,
		// Edits set aside before a reload are still the builder's to answer for.
		displaced: kept.kind === 'moved' ? kept.workspace : editsAside(key, workspace),
		discarded: kept.kind === 'discarded',
		project,
	};
}
