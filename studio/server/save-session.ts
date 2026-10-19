/**
 * Save for one open project: the review of what would change, the write with
 * its three proofs, and the undo. It reaches the disk and the project's process
 * only through the host it is given, so the rules can be run without either.
 *
 * @module
 */

import { relative, resolve } from 'node:path';
import type { ReadStep } from '../read-steps.ts';
import type { StudioWorkspace } from '../workspace.ts';
import { sourceOrigins } from './origins.ts';
import {
  type ProjectSource,
  projectOf,
  providerNamed,
  readProjectSource,
  sharedSettings,
  walkProject,
  writtenType,
} from './project-source.ts';
import { type ProjectNames, projectDiffers, projectNames, saveSubjects } from './save.ts';
import { planNew } from './save-new.ts';
import { applyEdits, diffHunks, planSave, type SourceEdit } from './save-plan.ts';
import { planRemoved } from './save-remove.ts';
import type {
  ProjectOrigins,
  ProviderPlace,
  SaveChange,
  SaveDone,
  SaveRefusal,
  SaveRequest,
  SaveReview,
  SettingOrigin,
  SettingSite,
  SharedSetting,
  Unregistered,
} from './save-wire.ts';

/** What Save needs from the machine. `Loaded` is one load of the project. */
export interface SaveHost<Loaded> {
  /** The folder Save may write in. */
  root: string;
  /** The project's setup module, inside `root`. */
  setupFile: string;
  /** A project file's text, or undefined when it is missing or leads outside the project. */
  read(path: string): string | undefined;
  /** Whether a write to this path lands inside `root`: no link on the way, or at it, leads out. */
  landsInside(path: string): boolean;
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

/** What one read of the project's files says. Each file is named from the project's folder. */
export interface FilesRead {
  /** The project's shared settings. */
  shared: SharedSetting[];
  /** The settings the files set in code. */
  origins: ProjectOrigins;
  /** The profiles and tools the files define that the project did not register. */
  unregistered: Unregistered[];
  /** Where the files define each provider the project registered. */
  providerPlaces: ProviderPlace[];
  /** What the project printed when the files did not load. */
  unloaded?: string;
}

/** Save for one project, and the load of it that answers requests now. */
export interface SaveSession<Loaded> {
  project(): Loaded;
  /** The absolute path of a file named from the project's folder, when the project's setup reads it. */
  place(file: string): string | undefined;
  /** The review when the request has no stamp; the write when it has the review's. */
  save(request: SaveRequest): Promise<SaveReview | SaveDone | SaveRefusal>;
  /** Puts the last Save's files back, when they still hold what it wrote. */
  undo(): Promise<SaveDone | SaveRefusal>;
  /**
   * What the project's files say now, from one read of them. Loads the project again first when
   * they changed outside the studio; when they do not load, the last load that did answers
   * requests until they do. `said` hears each step of the read as it happens.
   */
  read(said?: (step: ReadStep) => void): Promise<FilesRead>;
  /** Every file the project's setup reads, by absolute path. */
  watched(): string[];
  /**
   * The files that hold something other than what the load that answers was read from, each from
   * the project's folder. None after a Save or an undo: those are the studio's own writes.
   */
  changed(): Promise<string[]>;
}

/**
 * A file Save changes: its text now and its text after. `created` when Save makes the file,
 * `removed` when Save takes it away.
 */
type FileChange = { before: string; after: string; created: boolean; removed: boolean };
type Files = Map<string, FileChange>;
type Side = 'before' | 'after';
const other = (side: Side): Side => (side === 'before' ? 'after' : 'before');

/** Why nothing was done, with what to show for it. */
export const refusal = (reason: SaveRefusal['reason'], detail: string[] = []): SaveRefusal => ({
  ok: false,
  reason,
  detail,
});
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
  return (
    Array.isArray(workspace?.agents) &&
    Array.isArray(workspace.toolSpecs) &&
    typeof workspace.starts?.agents === 'object' &&
    typeof workspace.starts.tools === 'object'
  );
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
  return isSaveRequest(body)
    ? { status: 200, body: await session.save(body) }
    : { status: 400, body: {} };
}

/** Each profile and tool the files define that the project did not register, in the files' order. */
function unregisteredIn(
  source: Pick<ProjectSource, 'profiles' | 'tools'>,
  names: ProjectNames,
  inRoot: (file: string) => string,
): Unregistered[] {
  const idle = (
    kind: Unregistered['kind'],
    defined: ProjectSource['profiles'],
    registered: readonly string[],
  ) =>
    [...defined].flatMap(([name, [at]]): Unregistered[] => {
      if (!at || registered.includes(name)) return [];
      const { line } = at.source.getLineAndCharacterOfPosition(at.options.getStart(at.source));
      return [{ kind, name, file: inRoot(at.file), line: line + 1 }];
    });
  return [
    ...idle('profile', source.profiles, names.profiles),
    ...idle('tool', source.tools, names.tools),
  ];
}

/** Where the files define each provider the project registered: one written once, in the files' order. */
function providerPlaces(
  source: ProjectSource,
  names: ProjectNames,
  inRoot: (file: string) => string,
): ProviderPlace[] {
  return [...source.providers].flatMap(([id, targets]): ProviderPlace[] => {
    const [at] = targets;
    if (!at || targets.length > 1 || !names.providers.includes(id)) return [];
    const named = providerNamed(source, id);
    const { line } = at.source.getLineAndCharacterOfPosition(at.options.getStart(at.source));
    return [
      {
        id,
        ...(named ? { name: named.name } : {}),
        ...(named?.exported ? { exported: true as const } : {}),
        file: inRoot(at.file),
        line: line + 1,
      },
    ];
  });
}

/**
 * A project's origins as the page reads them: each file from the project's folder, and each
 * profile and tool the project registers that no file defines marked as one the studio cannot find.
 */
export function pageOrigins(
  found: ProjectOrigins,
  names: ProjectNames,
  source: Pick<ProjectSource, 'profiles' | 'tools' | 'providers'>,
  inRoot: (file: string) => string,
): ProjectOrigins {
  const read = (
    origins: Record<string, SettingOrigin[]>,
    registered: readonly string[],
    defined: Map<string, unknown>,
  ) => {
    const placed = Object.entries(origins).map(([name, held]): [string, SettingOrigin[]] => [
      name,
      held.map((origin) => (origin.file ? { ...origin, file: inRoot(origin.file) } : origin)),
    ]);
    const unfound = registered
      .filter((name) => !defined.has(name))
      .map((name): [string, SettingOrigin[]] => [name, [{ path: [], kind: 'unfound' }]]);
    return Object.fromEntries([...placed, ...unfound]);
  };
  const placed = (sites: Record<string, SettingSite[]>) =>
    Object.fromEntries(
      Object.entries(sites).map(([name, held]) => [
        name,
        held.map(
          (site): SettingSite => ({
            ...site,
            file: inRoot(site.file),
            ...(site.readBy
              ? { readBy: site.readBy.map((each) => ({ ...each, file: inRoot(each.file) })) }
              : {}),
          }),
        ),
      ]),
    );
  return {
    profiles: read(found.profiles, names.profiles, source.profiles),
    tools: read(found.tools, names.tools, source.tools),
    providers: read(found.providers, names.providers, source.providers),
    ...(found.sites
      ? { sites: { profiles: placed(found.sites.profiles), tools: placed(found.sites.tools) } }
      : {}),
  };
}

/** How long the walk runs before it pauses to let what it said go out. */
const PAUSE_EVERY_MS = 12;

/** Starts Save for a project that `first` loaded. */
export function createSaveSession<Loaded>(
  host: SaveHost<Loaded>,
  first: Loaded,
): SaveSession<Loaded> {
  const { root } = host;
  const inRoot = (file: string) => relative(root, file);
  let project = first;
  /** The last Save's files, until another Save or an undo. */
  let lastSave: Files | undefined;

  const source = () => readProjectSource(host.setupFile, root, host.read);
  /** The text of every file the setup reads, which changes when the builder's editor writes one. */
  const heldIn = (read: ProjectSource) =>
    JSON.stringify([...read.files].map(([file, each]) => [file, each.text]));
  const held = () => heldIn(source());
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
  const review = async (
    workspace: StudioWorkspace,
  ): Promise<{ view: SaveReview; files: Files } | SaveRefusal> => {
    const subjects = subjectsOf(workspace);
    if (!subjects.ok) return refusal('issues', subjects.issues);
    const source = readProjectSource(host.setupFile, root, host.read);
    const plan = planSave(source, subjects.subjects);
    const added = planNew(source, subjects.added, (path) => host.read(path) !== undefined);
    const files: Files = new Map();
    const view: SaveReview['files'] = [];
    const taken = planRemoved(source, subjects.removed);
    const whole = taken.gone.map(
      (file): SourceEdit => ({
        file,
        start: 0,
        end: source.files.get(file)?.text.length ?? 0,
        text: '',
      }),
    );
    const edits = [...plan.edits, ...added.edits, ...taken.edits].filter(
      (edit) => !taken.gone.includes(edit.file),
    );
    for (const [file, held] of Map.groupBy([...edits, ...whole], (edit: SourceEdit) => edit.file)) {
      const opened = source.files.get(file);
      const before = opened?.text ?? '';
      const removed = taken.gone.includes(file);
      let after: string;
      try {
        after = applyEdits(before, held);
      } catch (error) {
        return refusal('unwritable', [`${inRoot(file)}: ${message(error)}`]);
      }
      files.set(file, { before, after, created: !opened, removed });
      const marked = removed
        ? { removed: true as const }
        : opened
          ? {}
          : { created: true as const };
      view.push({ file: inRoot(file), hunks: diffHunks(before, held), ...marked });
    }
    const changes = [...subjects.changes, ...plan.changes, ...added.changes, ...taken.changes].map(
      (change: SaveChange) => (change.file ? { ...change, file: inRoot(change.file) } : change),
    );
    const writable = files.size > 0 && changes.every((change) => change.status === 'written');
    return {
      files,
      view: { ok: true, changes, files: view, stamp: await stampOf([...files]), writable },
    };
  };

  /** What a file holds on `side`: undefined where it is not there. */
  const textOn = (change: FileChange, side: Side) =>
    side === 'before'
      ? change.created
        ? undefined
        : change.before
      : change.removed
        ? undefined
        : change.after;

  /** Writes a file as it was or as Save makes it. A file that is not there on that side is taken away, not emptied. */
  const putFile = (file: string, change: FileChange, side: Side) => {
    const text = textOn(change, side);
    if (text === undefined) host.remove(file);
    else host.write(file, text);
  };

  /**
   * Writes each file to `side`. When one can't be written, the files already written, and that one,
   * are put back to the other side, and the refusal says which file and why.
   */
  const put = (files: Files, side: Side): SaveRefusal | undefined => {
    const done: Files = new Map();
    for (const [file, change] of files) {
      try {
        putFile(file, change, side);
      } catch (error) {
        const back = other(side);
        const kept = putBack(done, back);
        if (host.read(file) !== textOn(change, back)) {
          try {
            putFile(file, change, back);
          } catch {
            kept.push(inRoot(file));
          }
        }
        const refused = refusal('write', [`${inRoot(file)}: ${message(error)}`]);
        return kept.length ? { ...refused, kept } : refused;
      }
      done.set(file, change);
    }
    return undefined;
  };

  /**
   * Puts `files` back to `side`, but for a file that no longer holds what the other side wrote:
   * someone changed it meanwhile, so it is left as it is now. One that can't be written is left too.
   * Answers with those it left.
   */
  const putBack = (files: Files, side: Side): string[] => {
    const left: string[] = [];
    for (const [file, change] of files) {
      if (host.read(file) !== textOn(change, other(side))) {
        left.push(inRoot(file));
        continue;
      }
      try {
        putFile(file, change, side);
      } catch {
        left.push(inRoot(file));
      }
    }
    return left;
  };

  /** A write taken back, with the files it left as they are now. */
  const takenBack = (refused: SaveRefusal, files: Files, side: Side): SaveRefusal => {
    const kept = putBack(files, side);
    return kept.length ? { ...refused, kept } : refused;
  };

  /** Loads the project from disk and answers with it from now on. */
  const reload = async (
    keep: (next: Loaded) => string[],
    from = held(),
  ): Promise<SaveRefusal | undefined> => {
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

  /** Loads the project again when `files` are not the ones the load that answers was read from. Whether it did. */
  const refresh = async (
    files: ProjectSource,
    said?: (step: ReadStep) => void,
  ): Promise<boolean> => {
    const now = heldIn(files);
    if (now === loadedFrom) unloaded = undefined;
    // Files that did not load are not tried again until they change.
    else if (unloaded?.from !== now) {
      said?.({ again: true });
      const refused = await reload(() => [], now);
      if (refused) unloaded = { from: now, printed: refused.detail.join('\n') };
      return true;
    }
    return false;
  };

  /** The same walk as `source`, pausing so each step said reaches the page while the walk goes on. */
  const sourceSaying = async (said: (step: ReadStep) => void): Promise<ProjectSource> => {
    const walk = walkProject(host.setupFile, root, host.read);
    let paused = performance.now();
    let step = walk.next();
    while (!step.done) {
      const { file, from } = step.value;
      said({ file: inRoot(file), ...(from === undefined ? {} : { from: inRoot(from) }) });
      if (performance.now() - paused > PAUSE_EVERY_MS) {
        await new Promise((resume) => setTimeout(resume, 0));
        paused = performance.now();
      }
      step = walk.next();
    }
    const files = projectOf(step.value, host.setupFile, root);
    for (const [found, made] of [
      ['profile', files.profiles],
      ['tool', files.tools],
    ] as const) {
      for (const [name, targets] of made) {
        const at = targets[0];
        if (!at) continue;
        const type = writtenType(files, at);
        said({ found, name, file: inRoot(at.file), ...(type === undefined ? {} : { type }) });
      }
    }
    return files;
  };

  const read = async (said?: (step: ReadStep) => void): Promise<FilesRead> => {
    const first = said ? await sourceSaying(said) : source();
    // A load takes time, so the files are read again after one: the answer is what they say now.
    const loaded = await refresh(first, said);
    const files = loaded ? source() : first;
    const opened = host.opened(project);
    const decisions = opened.agents
      .filter((agent) => agent.identity.profileType === 'decision')
      .map((agent) => agent.identity.agentId);
    return {
      shared: sharedSettings(files).map((setting) => ({ ...setting, file: inRoot(setting.file) })),
      origins: pageOrigins(sourceOrigins(files, decisions), projectNames(opened), files, inRoot),
      unregistered: unregisteredIn(files, projectNames(opened), inRoot),
      providerPlaces: providerPlaces(files, projectNames(opened), inRoot),
      ...(unloaded === undefined ? {} : { unloaded: unloaded.printed }),
    };
  };

  /** Proves the files as written: the project type-checks, loads, and is what was tested. */
  const proven = async (tested: StudioWorkspace): Promise<SaveRefusal | undefined> => {
    const check = await host.typeChecks().catch((error) => ({ ok: false, output: message(error) }));
    if (!check.ok) return refusal('check', [check.output]);
    return reload((next) => projectDiffers(host.opened(next), tested));
  };

  const write = async (
    files: Files,
    view: SaveReview,
    request: SaveRequest,
  ): Promise<SaveDone | SaveRefusal> => {
    if (view.stamp !== request.stamp) return refusal('stale');
    if (!view.writable) return refusal('unwritable');
    const astray = [...files.keys()].filter((file) => !host.landsInside(file));
    if (astray.length) return refusal('unwritable', astray.map(inRoot));
    const failed = put(files, 'after');
    if (failed) return failed;
    const refused = await proven(request.workspace);
    if (refused) return takenBack(refused, files, 'before');
    lastSave = files;
    return { ok: true, written: [...files.keys()].map(inRoot) };
  };

  const save = async (request: SaveRequest) => {
    const reviewed = await review(request.workspace);
    if ('reason' in reviewed) return reviewed;
    return request.stamp === undefined
      ? reviewed.view
      : write(reviewed.files, reviewed.view, request);
  };

  const undo = async (): Promise<SaveDone | SaveRefusal> => {
    if (!lastSave) return refusal('nothing');
    const files = lastSave;
    const moved = [...files].filter(
      ([file, change]) => host.read(file) !== (change.removed ? undefined : change.after),
    );
    if (moved.length)
      return refusal(
        'stale',
        moved.map(([file]) => inRoot(file)),
      );
    const failed = put(files, 'before');
    if (failed) return failed;
    const refused = await reload(() => []);
    if (refused) return takenBack(refused, files, 'after');
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
    place: (file) => {
      const path = resolve(root, file);
      return source().files.has(path) ? path : undefined;
    },
    save: (request) => inTurn(() => save(request)),
    undo: () => inTurn(undo),
    read: (said) => inTurn(() => read(said)),
    watched: () => [...source().files.keys()],
    // In turn, so a Save that is still proving its files is not taken for the builder's editor.
    changed: () =>
      inTurn(() => {
        const now = held();
        if (now === loadedFrom) return Promise.resolve([]);
        const [was, is] = [loadedFrom, now].map(
          (text) => new Map(JSON.parse(text) as [string, string][]),
        );
        const files = [...new Set([...(was?.keys() ?? []), ...(is?.keys() ?? [])])];
        return Promise.resolve(
          files.filter((file) => was?.get(file) !== is?.get(file)).map(inRoot),
        );
      }),
  };
}
