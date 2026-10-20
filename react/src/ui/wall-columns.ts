/** How many columns at least `minWidth` wide fit across `width`, `gap` apart. Never fewer than one. */
export function columnCount(width: number, minWidth: number, gap: number): number {
  return Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
}

/**
 * Each card, in order, into the column that is shortest so far, by the
 * cards' heights and the gap under each. A card not measured yet counts as
 * no height, so unmeasured cards are dealt out in turn.
 */
export function wallColumns(
  heights: readonly (number | undefined)[],
  count: number,
  gap: number,
): number[][] {
  const columns = Array.from({ length: count }, (): number[] => []);
  const tall = Array.from({ length: count }, () => 0);
  heights.forEach((height, card) => {
    const at = tall.indexOf(Math.min(...tall));
    columns[at]?.push(card);
    tall[at] = (tall[at] ?? 0) + (height ?? 0) + gap;
  });
  return columns;
}
