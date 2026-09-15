/** ES2022-safe replacement for `Array.prototype.findLast`. */
export function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && predicate(item)) {
      return item;
    }
  }
  return undefined;
}
