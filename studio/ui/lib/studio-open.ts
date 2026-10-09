import { clearStaleStudioRuns, createExampleDraft, type StudioDraft, workspaceFromDraft } from '../../mod.ts';
import type { StudioOpened } from '../studio-host.ts';
import { openProject, type ProjectSession } from './studio-project.ts';
import { restoreStudio } from './studio-restore.ts';

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
 * What the studio opens on when a local server holds a project: the project's workspace. Nothing
 * of it is kept in the tab. Throws when no server answers.
 */
export async function openStudioProject(): Promise<StudioOpened & { project: ProjectSession }> {
	const { project, workspace } = await openProject();
	return {
		start: { workspace, revision: 0, transient: true },
		question: undefined,
		displaced: undefined,
		discarded: false,
		project,
	};
}
