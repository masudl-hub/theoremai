/**
 * Save for one open project: the review of what would change, the write with
 * its three proofs, and the undo. It reaches the disk and the project's process
 * only through the host it is given, so the rules can be run without either.
 *
 * @module
 */

import { relative, resolve } from 'node:path';
import type { StudioWorkspace } from '../workspace.ts';
import { sourceOrigins } from './origins.ts';
import { type ProjectSource, readProjectSource, sharedSettings } from './project-source.ts';
import { planNew } from './save-new.ts';
import { planRemoved } from './save-remove.ts';
import { applyEdits, diffHunks, planSave, type SourceEdit } from './save-plan.ts';
import { type ProjectNames, projectDiffers, projectNames, saveSubjects } from './save.ts';
import type {
  ProjectOrigins,
  SaveChange,
  SaveDone,
  SaveRefusal,
  SaveRequest,
  SaveReview,
  SettingOrigin,
  SharedSetting,
} from './save-wire.ts';

/** What Save needs from the machine. `Loaded` is one load of the project. */
export interface SaveHost<Loaded> {
  /** The folder Save may write in. */
  root: string;
  /** The project's setup module, inside `root`. */
  setupFile: string;
  /** A project file's text, or undefined when it is missing or leads outside the project. */
  read(path: string): string | undefined;
  /** Writes a file, with the folders that lead to it. */
  write(path: string, text: string): void;
  /** Takes away a file: one Save created, or one a removal left with nothing of its own. */
  remove(path: string): void;
  /** Whether the project type-checks as it is on disk, and what the checker printed. */
  typeChecks(): Promise<{ ok: boolean; output: string }>;
  /** Loads the project from disk. Throws what it printed when it does not start. */
  load(): Promise<Loaded>;
  stop(loaded: Loaded): Promise<void>;
  /** The workspace a load opened as. */
  opened(loaded: Loaded): StudioWorkspace;
}

/** Save for one project, and the load of it that answers requests now. */
export interface SaveSession<Loaded> {
  project(): Loaded;
  /** The project's shared settings as its files hold them now, each file from the project's folder. */
  shared(): SharedSetting[];
  /** The settings the project's files set in code, each file from the project's folder. */
  origins(): ProjectOrigins;
  /** The absolute path of a file named from the project's folder, when the project's setup reads it. */
  place(file: string): string | undefined;
  /** The review when the request has no stamp; the write when it has the review's. */
  save(request: SaveRequest): Promise<SaveReview | SaveDone | SaveRefusal>;
  /** Puts the last Save's files back, when they still hold what it wrote. */
  undo(): Promise<SaveDone | SaveRefusal>;
  /**
   * Loads the project again when its files changed outside the studio. Answers what the project
   * printed when the files do not load: the last load that did answers requests until they do.
   */
  refresh(): Promise<string | undefined>;
}

/**
 * A file Save changes: its text now and its text after. `created` when Save makes the file,
 * `removed` when Save takes it away.
 */
type FileChange = { before: string; after: string; created: boolean; removed: boolean };
type Files = Map<string, FileChange>;

/** Why nothing was done, with what to show for it. */
export const refusal = (reason: SaveRefusal['reason'], detail: string[] = []): SaveRefusal => ({ ok: false, reason, detail });
/** What a thrown value says. */
export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A name for a value that changes when the value does. */
export async function stampOf(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Whether a body is a Save request, or one for the edited load: a workspace with its starts. */
export function isSaveRequest(body: unknown): body is SaveRequest {
  const workspace = (body as SaveRequest | null)?.workspace;
  return Array.isArray(workspace?.agents) && Array.isArray(workspace.toolSpecs) &&
    typeof workspace.starts?.agents === 'object' && typeof workspace.starts.tools === 'object';
}

/**
 * What Save answers a request with, as a status and a body: the review or the write at `base`, and
 * the undo at `base/undo`. Undefined when the request is not Save's.
 */
export async function answerSave<Loaded>(
  session: Pick<SaveSession<Loaded>, 'save' | 'undo'>,
  base: string,
  request: Request,
): Promise<{ status: number; body: unknown } | undefined> {
  if (request.method !== 'POST') return undefined;
  const path = new URL(request.url).pathname;
  if (path === `${base}/undo`) return { status: 200, body: await session.undo() };
  if (path !== base) return undefined;
  const body: unknown = await request.json().catch(() => null);
  return isSaveRequest(body) ? { status: 200, body: await session.save(body) } : { status: 400, body: {} };
}

/**
 * A project's origins as the page reads them: each file from the project's folder, and each
 * profile and tool the project registers that no file defines marked as one the studio cannot find.
 */
export function pageOrigins(
  found: ProjectOrigins,
  names: ProjectNames,
  source: Pick<ProjectSource, 'profiles' | 'tools'>,
  inRoot: (file: string) => string,
): ProjectOrigins {
  const read = (origins: Record<string, SettingOrigin[]>, registered: readonly string[], defined: Map<string, unknown>) => {
    const placed = Object.entries(origins).map(([name, held]): [string, SettingOrigin[]] => [
      name,
      held.map((origin) => (origin.file ? { ...origin, file: inRoot(origin.file) } : origin)),
    ]);
    const unfound = registered.filter((name) => !defined.has(name))
      .map((name): [string, SettingOrigin[]] => [name, [{ path: [], kind: 'unfound' }]]);
    return Object.fromEntries([...placed, ...unfound]);
  };
  return {
    profiles: read(found.profiles, names.profiles, source.profiles),
    tools: read(found.tools, names.tools, source.tools),
  };
}

/** Starts Save for a project that `first` loaded. */
export function createSaveSession<Loaded>(host: SaveHost<Loaded>, first: Loaded): SaveSession<Loaded> {
  const { root } = host;
  const inRoot = (file: string) => relative(root, file);
  let project = first;
  /** The last Save's files, until another Save or an undo. */
  let lastSave: Files | undefined;

  const source = () => readProjectSource(host.setupFile, root, host.read);
  /** The text of every file the setup reads, which changes when the builder's editor writes one. */
  const held = () => JSON.stringify([...source().files].map(([file, read]) => [file, read.text]));
  /** What the files held when the load that answers started. */
  let loadedFrom = held();
  /** The files that did not load, and what the project printed. */
  let unloaded: { from: string; printed: string } | undefined;

  /** What the builder changed, or why it cannot be read. */
  const subjectsOf = (workspace: StudioWorkspace): ReturnType<typeof saveSubjects> => {
    try {
      return saveSubjects(workspace, projectNames(host.opened(project)));
    } catch (error) {
      return { ok: false, issues: [message(error)] };
    }
  };

  /** The review of a workspace's changes, with the files they would write. */
  const review = async (workspace: StudioWorkspace): Promise<{ view: SaveReview; files: Files } | SaveRefusal> => {
    const subjects = subjectsOf(workspace);
    if (!subjects.ok) return refusal('issues', subjects.issues);
    const source = readProjectSource(host.setupFile, root, host.read);
    const plan = planSave(source, subjects.subjects);
    const added = planNew(source, subjects.added, (path) => host.read(path) !== undefined);
    const files: Files = new Map();
    const view: SaveReview['files'] = [];
    const taken = planRemoved(source, subjects.removed);
    const whole = taken.gone.map((file): SourceEdit => ({ file, start: 0, end: source.files.get(file)?.text.length ?? 0, text: '' }));
    const edits = [...plan.edits, ...added.edits, ...taken.edits].filter((edit) => !taken.gone.includes(edit.file));
    for (const [file, held] of Map.groupBy([...edits, ...whole], (edit: SourceEdit) => edit.file)) {
      const opened = source.files.get(file);
      const before = opened?.text ?? '';
      const removed = taken.gone.includes(file);
      files.set(file, { before, after: applyEdits(before, held), created: !opened, removed });
      const marked = removed ? { removed: true as const } : opened ? {} : { created: true as const };
      view.push({ file: inRoot(file), hunks: diffHunks(before, held), ...marked });
    }
    const changes = [...subjects.changes, ...plan.changes, ...added.changes, ...taken.changes].map((change: SaveChange) =>
      change.file ? { ...change, file: inRoot(change.file) } : change
    );
    const writable = files.size > 0 && changes.every((change) => change.status === 'written');
    return { files, view: { ok: true, changes, files: view, stamp: await stampOf([...files]), writable } };
  };

  /** Writes each file as it was or as Save makes it. A file that is not there on that side is taken away, not emptied. */
  const put = (files: Files, side: 'before' | 'after') => {
    for (const [file, change] of files) {
      if (side === 'before' ? change.created : change.removed) host.remove(file);
      else host.write(file, change[side]);
    }
  };

  /** Loads the project from disk and answers with it from now on. */
  const reload = async (keep: (next: Loaded) => string[]): Promise<SaveRefusal | undefined> => {
    const from = held();
    let next: Loaded;
    try {
      next = await host.load();
    } catch (error) {
      return refusal('load', [message(error)]);
    }
    const differs = keep(next);
    if (differs.length) {
      await host.stop(next);
      return refusal('differs', differs);
    }
    const old = project;
    project = next;
    loadedFrom = from;
    unloaded = undefined;
    await host.stop(old);
    return undefined;
  };

  const refresh = async (): Promise<string | undefined> => {
    const now = held();
    if (now === loadedFrom) unloaded = undefined;
    // Files that did not load are not tried again until they change.
    else if (unloaded?.from !== now) {
      const refused = await reload(() => []);
      if (refused) unloaded = { from: now, printed: refused.detail.join('\n') };
    }
    return unloaded?.printed;
  };

  /** Proves the files as written: the project type-checks, loads, and is what was tested. */
  const proven = async (tested: StudioWorkspace): Promise<SaveRefusal | undefined> => {
    const check = await host.typeChecks();
    if (!check.ok) return refusal('check', [check.output]);
    return reload((next) => projectDiffers(host.opened(next), tested));
  };

  const write = async (files: Files, view: SaveReview, request: SaveRequest): Promise<SaveDone | SaveRefusal> => {
    if (view.stamp !== request.stamp) return refusal('stale');
    if (!view.writable) return refusal('unwritable');
    put(files, 'after');
    const refused = await proven(request.workspace);
    if (refused) {
      put(files, 'before');
      return refused;
    }
    lastSave = files;
    return { ok: true, written: [...files.keys()].map(inRoot) };
  };

  const save = async (request: SaveRequest) => {
    const reviewed = await review(request.workspace);
    if ('reason' in reviewed) return reviewed;
    return request.stamp === undefined ? reviewed.view : write(reviewed.files, reviewed.view, request);
  };

  const undo = async (): Promise<SaveDone | SaveRefusal> => {
    if (!lastSave) return refusal('nothing');
    const files = lastSave;
    const moved = [...files].filter(([file, change]) => host.read(file) !== (change.removed ? undefined : change.after));
    if (moved.length) return refusal('stale', moved.map(([file]) => inRoot(file)));
    put(files, 'before');
    const refused = await reload(() => []);
    if (refused) {
      put(files, 'after');
      return refused;
    }
    lastSave = undefined;
    return { ok: true, written: [...files.keys()].map(inRoot) };
  };

  /** One write at a time: a second waits for the first. */
  let writing: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = writing.then(work, work);
    writing = next.catch(() => {});
    return next;
  };

  return {
    project: () => project,
    shared: () => sharedSettings(source()).map((setting) => ({ ...setting, file: inRoot(setting.file) })),
    origins: () => {
      const read = source();
      const opened = host.opened(project);
      const decisions = opened.agents.filter((agent) => agent.identity.profileType === 'decision')
        .map((agent) => agent.identity.agentId);
      return pageOrigins(sourceOrigins(read, decisions), projectNames(opened), read, inRoot);
    },
    place: (file) => {
      const path = resolve(root, file);
      return source().files.has(path) ? path : undefined;
    },
    save: (request) => inTurn(() => save(request)),
    undo: () => inTurn(undo),
    refresh: () => inTurn(refresh),
  };
}
