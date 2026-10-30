import {
  createResearchWorkspace,
  type StudioDraft,
  type StudioWorkspace,
  workspaceFromDraft,
} from '../../mod.ts';
import type { ReadStep } from '../../read-steps.ts';
import type { StudioOpened } from '../studio-host.ts';
import { openProject, type ProjectSession } from './studio-project.ts';
import { editsAside, restoreProject, restoreStudio } from './studio-restore.ts';
import { projectKey, tabStorage } from './studio-session.ts';

/**
 * What the studio opens on in this tab. Draft keys are random, so this runs in the browser. The
 * tab's kept workspace comes back unless a `seed` asks for another; then it waits behind Undo.
 */
export async function openStudio(
  seed?:
    | { draft: StudioDraft; question: string | undefined }
    | { workspace: StudioWorkspace; question: string | undefined },
): Promise<StudioOpened> {
  await tabStorage();
  const kept = restoreStudio();
  const freshWorkspace = (workspace: StudioWorkspace) => ({
    workspace,
    revision: kept.kind === 'restored' ? kept.value.revision + 1 : 0,
  });
  if (seed) {
    const workspace = 'workspace' in seed ? seed.workspace : workspaceFromDraft(seed.draft);
    return {
      start: freshWorkspace(workspace),
      question: seed.question,
      displaced: kept.kind === 'restored' ? kept.value.workspace : undefined,
      discarded: kept.kind === 'discarded',
    };
  }
  if (kept.kind === 'restored')
    return { start: kept.value, question: undefined, displaced: undefined, discarded: false };
  return {
    start: freshWorkspace(createResearchWorkspace()),
    question: undefined,
    displaced: undefined,
    discarded: kept.kind === 'discarded',
  };
}

/**
 * What the studio opens on when a local server holds a project: the project's workspace, with the
 * edits this tab kept for it. The studio merges into them what the files changed since; edits
 * that stand on no reading of the files wait behind an offer until the builder answers it.
 * Closing the tab forgets them. `said` hears each step of the server's read of the project's
 * files. Throws when no server answers.
 */
export async function openStudioProject(
  said?: (step: ReadStep) => void,
): Promise<StudioOpened & { project: ProjectSession }> {
  const [{ project, workspace }] = await Promise.all([openProject(said), tabStorage()]);
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
