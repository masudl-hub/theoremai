/**
 * The second load of an open project: the files with the builder's unsaved edits laid over them,
 * so one message can be answered by both. It starts when the page asks for it, is replaced when
 * the edits change, and ends when the files do. It reaches the project's process only through the
 * host it is given, so the rules can be run without one.
 *
 * @module
 */

import type { StudioWorkspace } from '../workspace.ts';
import type { ProjectEdits } from './edits.ts';
import { message, refusal, stampOf } from './save-session.ts';
import { projectDiffers, projectNames, saveSubjects, withoutRemoved } from './save.ts';
import type { EditedAnswer } from './save-wire.ts';

/** What the edited load needs from the machine. `Loaded` is one load of the project. */
export interface EditedHost<Loaded> {
  /** Loads the project from disk with the edits laid over it. Throws what it printed when it does not start. */
  load(edits: ProjectEdits): Promise<Loaded>;
  stop(loaded: Loaded): Promise<void>;
  /** The workspace a load opened as. */
  opened(loaded: Loaded): StudioWorkspace;
}

export interface EditedSession<Loaded> {
  /** Makes the running load the one that holds this workspace's edits. `saved` is the files' load. */
  open(workspace: StudioWorkspace, saved: Loaded): Promise<EditedAnswer>;
  /** The load that answers now, when there is one. */
  running(): Loaded | undefined;
  /** Ends the load: the files changed, so its edits lie over files that are gone. */
  close(): Promise<void>;
}

/**
 * The load with each added tool's sample reply as the page holds it. A tool added here has no
 * file to read its sample reply from, and the load answers with it all the same.
 */
function withSampleReplies(
  loaded: StudioWorkspace,
  tested: StudioWorkspace,
  added: readonly { name: string }[],
): StudioWorkspace {
  const fresh = new Set(added.map((tool) => tool.name));
  const held = new Map(tested.toolSpecs.map((tool) => [tool.toolName, tool.stubOutputJson]));
  return {
    ...loaded,
    toolSpecs: loaded.toolSpecs.map((tool) => {
      const reply = fresh.has(tool.toolName) ? held.get(tool.toolName) : undefined;
      return reply === undefined ? tool : { ...tool, stubOutputJson: reply };
    }),
  };
}

export function createEditedSession<Loaded>(host: EditedHost<Loaded>): EditedSession<Loaded> {
  let held: { loaded: Loaded; stamp: string } | undefined;

  const close = async () => {
    const old = held;
    held = undefined;
    if (old) await host.stop(old.loaded);
  };

  type Opened = { ok: true; stamp: string } | ReturnType<typeof refusal>;
  const start = async (workspace: StudioWorkspace, names: ReturnType<typeof projectNames>): Promise<Opened> => {
    let subjects: ReturnType<typeof saveSubjects>;
    try {
      subjects = saveSubjects(workspace, names);
    } catch (error) {
      return refusal('issues', [message(error)]);
    }
    if (!subjects.ok) return refusal('issues', subjects.issues);
    const edits: ProjectEdits = { subjects: subjects.subjects, added: subjects.added };
    const stamp = await stampOf(edits);
    if (held?.stamp === stamp) return { ok: true, stamp };
    await close();
    let loaded: Loaded;
    try {
      loaded = await host.load(edits);
    } catch (error) {
      return refusal('load', [message(error)]);
    }
    // The same proof Save makes of the files it wrote: this load is what the builder is testing.
    // What the builder removed is still in this load, where nothing the page shows can reach it.
    const opened = withSampleReplies(host.opened(loaded), workspace, subjects.added.tools);
    const differs = projectDiffers(withoutRemoved(opened, subjects.removed), workspace);
    if (differs.length) {
      await host.stop(loaded);
      return refusal('differs', differs);
    }
    held = { loaded, stamp };
    return { ok: true, stamp };
  };

  const open = async (workspace: StudioWorkspace, saved: Loaded): Promise<EditedAnswer> => {
    const names = projectNames(host.opened(saved));
    return { ...(await start(workspace, names)), saved: [...names.profiles] };
  };

  /** One at a time: a second request waits for the first. */
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = turn.then(work, work);
    turn = next.catch(() => {});
    return next;
  };

  return {
    open: (workspace, saved) => inTurn(() => open(workspace, saved)),
    running: () => held?.loaded,
    close: () => inTurn(close),
  };
}
