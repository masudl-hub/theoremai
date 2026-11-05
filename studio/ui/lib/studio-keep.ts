/**
 * Where the studio keeps itself in this browser: IndexedDB, each record under the id of the tab
 * that wrote it, and each run handed to a new tab under the run's id until that tab takes it.
 * Keys never come here: the vault stays in memory, and a run tab asks the studio tab for its keys.
 */

/** A tab gone this long has closed, not reloaded: another studio tab that opens clears its records. */
export const GONE_MS = 60_000;

/** The studio's records, by the tab that wrote them. */
export interface Keep {
  /**
   * Takes the tab's records: says the tab is here, and returns what it kept. With `from`, the
   * tab is a copy of that one (a duplicated tab), so it starts with a copy of its records.
   */
  claim(tab: string, from: string | undefined): Promise<Array<[string, string]>>;
  /** Keeps a record. One the browser refuses to keep is forgotten, so an older one does not come back. */
  put(tab: string, name: string, value: string): void;
  remove(tab: string, name: string): void;
  /** Keeps a run for the tab it opens in, beside the records of the tab that opened it. */
  handOff(run: string, opener: string, value: string): void;
  /** Moves a handed-off run into `tab`'s records under `name`; undefined when no tab handed it off. */
  takeRun(run: string, tab: string, name: string): Promise<string | undefined>;
  /** Clears the records of each tab that has been gone `GONE_MS`. `alive` names the tabs open now. */
  sweep(alive: ReadonlySet<string>, now: number): Promise<void>;
}

/** What a sweep does with each tab it knows of, from when each was first seen gone. */
export function sweepPlan(
  tabs: Iterable<string>,
  gone: ReadonlyMap<string, number>,
  alive: ReadonlySet<string>,
  now: number,
): { seen: string[]; back: string[]; clear: string[] } {
  const plan = { seen: [] as string[], back: [] as string[], clear: [] as string[] };
  for (const tab of new Set([...tabs, ...gone.keys()])) {
    const since = gone.get(tab);
    if (alive.has(tab)) {
      if (since !== undefined) plan.back.push(tab);
    } else if (since === undefined) plan.seen.push(tab);
    else if (now - since >= GONE_MS) plan.clear.push(tab);
  }
  return plan;
}

/** A keep that lasts as long as the page: where the browser has no IndexedDB or no Web Locks, and in tests. */
export function memoryKeep(): Keep {
  const tabs = new Map<string, Map<string, string>>();
  const runs = new Map<string, { opener: string; value: string }>();
  const gone = new Map<string, number>();
  const records = (tab: string) => {
    const kept = tabs.get(tab) ?? new Map<string, string>();
    tabs.set(tab, kept);
    return kept;
  };
  return {
    claim(tab, from) {
      gone.delete(tab);
      if (from !== undefined)
        for (const [name, value] of tabs.get(from) ?? []) records(tab).set(name, value);
      return Promise.resolve([...records(tab)]);
    },
    put(tab, name, value) {
      records(tab).set(name, value);
    },
    remove(tab, name) {
      tabs.get(tab)?.delete(name);
    },
    handOff(run, opener, value) {
      runs.set(run, { opener, value });
    },
    takeRun(run, tab, name) {
      const handed = runs.get(run);
      if (!handed) return Promise.resolve(undefined);
      runs.delete(run);
      records(tab).set(name, handed.value);
      return Promise.resolve(handed.value);
    },
    sweep(alive, now) {
      const openers = [...runs.values()].map((run) => run.opener);
      const plan = sweepPlan([...tabs.keys(), ...openers], gone, alive, now);
      for (const tab of plan.seen) gone.set(tab, now);
      for (const tab of plan.back) gone.delete(tab);
      for (const tab of plan.clear) {
        tabs.delete(tab);
        gone.delete(tab);
        for (const [run, handed] of runs) if (handed.opener === tab) runs.delete(run);
      }
      return Promise.resolve();
    },
  };
}

const DATABASE = 'theorem.studio';
const TABS = 'tabs';
const RUNS = 'runs';
const GONE = 'gone';

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB refused the request.'));
    };
  });
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB did not keep the change.'));
    };
  });
}

/** Every record of `tab`: its names sort under it, and a list sorts after every name. */
const ofTab = (tab: string) => IDBKeyRange.bound([tab], [tab, []]);

/** The keep in this browser's IndexedDB. Rejects where IndexedDB is missing or refuses to open. */
export async function indexedDbKeep(): Promise<Keep> {
  const opening = indexedDB.open(DATABASE, 1);
  opening.onupgradeneeded = () => {
    const db = opening.result;
    db.createObjectStore(TABS);
    db.createObjectStore(RUNS);
    db.createObjectStore(GONE);
  };
  const db = await result(opening);
  const write = (
    stores: string[],
    change: (transaction: IDBTransaction) => void,
    undo?: () => void,
  ) => {
    const transaction = db.transaction(stores, 'readwrite');
    change(transaction);
    finished(transaction).catch(() => undo?.());
  };
  const forget = (tab: string, name: string) => {
    write([TABS], (transaction) => transaction.objectStore(TABS).delete([tab, name]));
  };
  return {
    async claim(tab, from) {
      const transaction = db.transaction([TABS, GONE], 'readwrite');
      const done = finished(transaction);
      const kept = transaction.objectStore(TABS);
      transaction.objectStore(GONE).delete(tab);
      if (from !== undefined) {
        const [names, values] = await Promise.all([
          result(kept.getAllKeys(ofTab(from))),
          result(kept.getAll(ofTab(from))),
        ]);
        names.forEach((key, at) => {
          kept.put(values[at], [tab, (key as [string, string])[1]]);
        });
      }
      const [names, values] = await Promise.all([
        result(kept.getAllKeys(ofTab(tab))),
        result(kept.getAll(ofTab(tab))),
      ]);
      await done;
      return names.map((key, at): [string, string] => [
        (key as [string, string])[1],
        String(values[at]),
      ]);
    },
    put(tab, name, value) {
      write(
        [TABS],
        (transaction) => transaction.objectStore(TABS).put(value, [tab, name]),
        () => {
          forget(tab, name);
        },
      );
    },
    remove(tab, name) {
      forget(tab, name);
    },
    handOff(run, opener, value) {
      // invariant: the write is queued before the run tab opens, so its read comes after it.
      write([RUNS], (transaction) => transaction.objectStore(RUNS).put({ opener, value }, run));
    },
    async takeRun(run, tab, name) {
      const transaction = db.transaction([RUNS, TABS], 'readwrite');
      const done = finished(transaction);
      const handed = (await result(transaction.objectStore(RUNS).get(run))) as
        | { opener: string; value: string }
        | undefined;
      if (handed) {
        transaction.objectStore(RUNS).delete(run);
        transaction.objectStore(TABS).put(handed.value, [tab, name]);
      }
      await done;
      return handed?.value;
    },
    async sweep(alive, now) {
      const transaction = db.transaction([TABS, RUNS, GONE], 'readwrite');
      const done = finished(transaction);
      const tabs = transaction.objectStore(TABS);
      const runs = transaction.objectStore(RUNS);
      const goneStore = transaction.objectStore(GONE);
      const [names, runIds, handed, goneIds, goneSince] = await Promise.all([
        result(tabs.getAllKeys()),
        result(runs.getAllKeys()),
        result(runs.getAll()),
        result(goneStore.getAllKeys()),
        result(goneStore.getAll()),
      ]);
      const openers = (handed as Array<{ opener: string }>).map((run) => run.opener);
      const gone = new Map(goneIds.map((tab, at) => [String(tab), Number(goneSince[at])]));
      const plan = sweepPlan(
        [...names.map((key) => (key as [string, string])[0]), ...openers],
        gone,
        alive,
        now,
      );
      for (const tab of plan.seen) goneStore.put(now, tab);
      for (const tab of plan.back) goneStore.delete(tab);
      const clear = new Set(plan.clear);
      for (const tab of clear) {
        tabs.delete(ofTab(tab));
        goneStore.delete(tab);
      }
      openers.forEach((opener, at) => {
        const run = runIds[at];
        if (clear.has(opener) && run !== undefined) runs.delete(run);
      });
      await done;
    },
  };
}
