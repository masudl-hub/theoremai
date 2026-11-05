import { type Keep, memoryKeep } from '../ui/lib/studio-keep.ts';
import { openTabStorage, type TabStorage } from '../ui/lib/studio-session.ts';

/** Every value the test tab wrote to the browser's keep, in order. */
export const written: string[] = [];

const inner = memoryKeep();
/** A keep in memory that notes each value written to it. */
const keep: Keep = {
  ...inner,
  put(tab, name, value) {
    written.push(value);
    inner.put(tab, name, value);
  },
  handOff(run, opener, value) {
    written.push(value);
    inner.handOff(run, opener, value);
  },
};

const records = await openTabStorage({ keep });

/** The test tab's records, kept in memory; `clear` empties them, as a fresh tab starts. */
export const tab: TabStorage & { clear(): void } = {
  ...records,
  clear() {
    for (const name of records.keys()) records.removeItem(name);
  },
};
