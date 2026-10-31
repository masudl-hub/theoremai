/**
 * Where the studio keeps itself: this tab's records in the browser's keep (see `studio-keep.ts`),
 * under the keys and in the record shape the workspace store, its restore, and the kept
 * conversations share. The tab's id waits in its sessionStorage, so a reload finds its records,
 * and a duplicated tab starts with a copy of them.
 */
import type { STUDIO_WORKSPACE_VERSION, StudioWorkspace } from '../../mod.ts';
import { GONE_MS, indexedDbKeep, type Keep, memoryKeep } from './studio-keep.ts';

export const WORKSPACE_KEY = 'theorem.studio.v2';
/** A project's workspace is kept under its own name, apart from the website's and other projects'. */
export const projectKey = (name: string) => `${WORKSPACE_KEY}.project:${name}`;
/** One conversation per agent, under this and the agent's key. */
export const CHAT_PREFIX = 'theorem.studio.v2.chat:';

/** A kept workspace, read back with its revision. */
export interface RestoredStudio {
  workspace: StudioWorkspace;
  revision: number;
  /**
   * A project's workspace: the key it is kept under, and the print of the files its starts stand
   * on. A reload brings the edits back while the files still print the same.
   */
  project?: { key: string; files: string };
}

/** What the tab keeps for a workspace. */
export interface StoredWorkspace {
  v: typeof STUDIO_WORKSPACE_VERSION;
  workspace: StudioWorkspace;
  revision: number;
  /** For a project's workspace: the print of the files its starts stand on. */
  files?: string;
}

/** This tab's records: read from memory, each change written through to the keep. Never throws. */
export interface TabStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  /** `setItem` as the page goes: the next load of this tab reads it, whether or not the keep did. */
  setItemLeaving(name: string, value: string): void;
  removeItem(name: string): void;
  keys(): string[];
}

/** The part of the Web Locks API the tab uses. */
export type TabLocks = Pick<LockManager, 'request' | 'query'>;

/** In this tab's sessionStorage: the id its records are kept under. */
const TAB_ID = 'theorem.studio.tab';
const TAB_LOCK = 'theorem.studio.tab:';
/** In this tab's sessionStorage: the record the page wrote as it went, until the next load. */
const LEAVING = 'theorem.studio.leaving';
/** Held while a tab claims its records and while a sweep runs, so a sweep never sees a tab half open. */
const SWEEP_LOCK = 'theorem.studio.sweep';

interface OpenTab {
  id: string;
  keep: Keep;
  records: Map<string, string>;
  storage: TabStorage;
}

let open: OpenTab | undefined;
let opening: Promise<TabStorage> | undefined;

/** This tab's records, once `openTabStorage` has opened them; null before. */
export function session(): TabStorage | null {
  return open?.storage ?? null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** This tab's sessionStorage, or null where there is none or it is blocked. */
export function tabSession(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Sets aside or clears the record in `LEAVING`. A full or blocked sessionStorage keeps nothing. */
function setLeaving(record?: { name: string; value: string }): void {
  try {
    if (record) tabSession()?.setItem(LEAVING, JSON.stringify(record));
    else tabSession()?.removeItem(LEAVING);
  } catch {
    // The keep's own write may still land.
  }
}

/** The record the last page set aside, if it left one. */
function readLeaving(): { name: string; value: string } | undefined {
  try {
    const raw = tabSession()?.getItem(LEAVING);
    return raw ? (JSON.parse(raw) as { name: string; value: string }) : undefined;
  } catch {
    return undefined;
  }
}

/** Holds `name` for as long as the page lives, if no one holds it now. */
function hold(locks: TabLocks, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    void locks.request(name, { ifAvailable: true }, (lock) => {
      resolve(lock !== null);
      return lock ? new Promise<never>(() => {}) : undefined;
    });
  });
}

/**
 * The tab's id, and the tab it is a copy of when another open tab holds the id it found. With
 * `copy` false the tab starts with no records: a run tab finds its opener's id, and is not a copy.
 */
async function tabIdentity(
  locks: TabLocks | undefined,
  copy: boolean,
): Promise<{ id: string; from?: string }> {
  const store = tabSession();
  let found: string | null = null;
  try {
    found = store?.getItem(TAB_ID) ?? null;
  } catch {
    // A tab that keeps nothing in sessionStorage starts fresh on each load.
  }
  if (found && (!locks || (await hold(locks, `${TAB_LOCK}${found}`)))) return { id: found };
  const id = crypto.randomUUID();
  if (locks) await hold(locks, `${TAB_LOCK}${id}`);
  try {
    store?.setItem(TAB_ID, id);
  } catch {
    // As above.
  }
  return found && copy ? { id, from: found } : { id };
}

/** Clears the records of tabs that have closed. Runs after the tab opens; nothing waits for it. */
async function sweepClosed(keep: Keep, locks: TabLocks): Promise<void> {
  await locks.request(SWEEP_LOCK, async () => {
    const { held = [] } = await locks.query();
    const alive = new Set(
      held.flatMap((lock) =>
        lock.name?.startsWith(TAB_LOCK) ? [lock.name.slice(TAB_LOCK.length)] : [],
      ),
    );
    await keep.sweep(alive, Date.now());
  });
}

/** The browser's keep and locks; a keep in memory where IndexedDB or Web Locks is missing or refused. */
async function browserKeep(): Promise<{ keep: Keep; locks?: TabLocks }> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks || typeof indexedDB === 'undefined') return { keep: memoryKeep() };
  try {
    return { keep: await indexedDbKeep(), locks };
  } catch {
    return { keep: memoryKeep() };
  }
}

/**
 * Opens this tab's records, and clears those of tabs that have closed: now, and each `GONE_MS`
 * while the page is open, so a tab seen closed is cleared at the next sweep. `copy` false opens a run tab, which
 * starts with no copy of the tab that opened it. `keep` and `locks` replace the browser's, as a
 * test does.
 */
export async function openTabStorage(
  options: { copy?: boolean; keep?: Keep; locks?: TabLocks } = {},
): Promise<TabStorage> {
  const { keep, locks } = options.keep
    ? { keep: options.keep, locks: options.locks }
    : await browserKeep();
  const claim = async () => {
    const { id, from } = await tabIdentity(locks, options.copy ?? true);
    return { id, kept: await keep.claim(id, from) };
  };
  const { id, kept } = locks ? await locks.request(SWEEP_LOCK, claim) : await claim();
  const records = new Map(kept);
  const setItem = (name: string, value: string) => {
    records.set(name, value);
    keep.put(id, name, value);
  };
  const leaving = readLeaving();
  if (leaving) setItem(leaving.name, leaving.value);
  setLeaving();
  const storage: TabStorage = {
    getItem: (name) => records.get(name) ?? null,
    setItem: (name, value) => {
      setItem(name, value);
      // why: a page brought back from the browser's cache goes on, and this write is newer.
      setLeaving();
    },
    // why: a write to the keep begun on pagehide does not finish before a reload reads it.
    setItemLeaving: (name, value) => {
      setItem(name, value);
      setLeaving({ name, value });
    },
    removeItem: (name) => {
      if (records.delete(name)) keep.remove(id, name);
    },
    keys: () => [...records.keys()],
  };
  open = { id, keep, records, storage };
  opening = Promise.resolve(storage);
  if (locks) {
    const sweep = () => {
      sweepClosed(keep, locks).catch(() => {});
    };
    sweep();
    setInterval(sweep, GONE_MS);
  }
  return storage;
}

/** This tab's records, opened once for the page. A run tab opens them with `copy` false. */
export function tabStorage(options?: { copy?: boolean }): Promise<TabStorage> {
  opening ??= openTabStorage(options);
  return opening;
}

/** Keeps a run for the tab it opens in. The tab must have opened its records. */
export function handOffRun(run: string, value: string): void {
  open?.keep.handOff(run, open.id, value);
}

const RUN_PREFIX = 'theorem.studio.run:';

/** The run this tab opens, taken from the tab that handed it off, or kept since it was. */
export async function takeRun(run: string): Promise<string | undefined> {
  await tabStorage({ copy: false });
  if (!open) return undefined;
  const name = `${RUN_PREFIX}${run}`;
  const kept = open.records.get(name);
  if (kept !== undefined) return kept;
  const taken = await open.keep.takeRun(run, open.id, name);
  if (taken !== undefined) open.records.set(name, taken);
  return taken;
}
