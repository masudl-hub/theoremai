/** `Array.prototype.findLast` is ES2023; this stays ES2022-safe. */
export function findLast<T, S extends T>(
  items: readonly T[],
  predicate: (item: T) => item is S,
): S | undefined;
export function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined;
export function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && predicate(item)) {
      return item;
    }
  }
  return undefined;
}
