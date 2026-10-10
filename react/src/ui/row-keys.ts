import { useRef } from 'react';

/** One item of a list with the React key it renders under. */
export type KeyedRow<T> = { item: T; index: number; key: string };

/**
 * Keys a read-only list by what each item says, so a repeated item is told apart by how many
 * times it has appeared before. `base` must return the same text for the same item.
 */
export function keyedByContent<T>(items: readonly T[], base: (item: T) => string): KeyedRow<T>[] {
  const seen = new Map<string, number>();
  return items.map((item, index) => {
    const text = base(item);
    const count = seen.get(text) ?? 0;
    seen.set(text, count + 1);
    return { item, index, key: `${text}#${String(count)}` };
  });
}

/**
 * Keys an editable list by identity: a row keeps its key while its text changes, and `drop`
 * retires the key of a removed row so the rows after it keep theirs.
 */
export function useKeyedRows<T>(items: readonly T[]): {
  rows: KeyedRow<T>[];
  drop: (index: number) => void;
} {
  const keys = useRef<string[]>([]);
  const minted = useRef(0);
  while (keys.current.length < items.length) {
    keys.current.push(String(minted.current));
    minted.current += 1;
  }
  keys.current.length = items.length;
  return {
    rows: items.map((item, index) => ({ item, index, key: keys.current[index] ?? '' })),
    drop: (index) => {
      keys.current.splice(index, 1);
    },
  };
}
