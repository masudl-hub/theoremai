/** How many columns at least `minWidth` wide fit across `width`, `gap` apart. Never fewer than one. */
export function columnCount(width: number, minWidth: number, gap: number): number {
  return Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
}

/** Where one card sits: its column and its distance from the top of the wall. */
export type WallPlace = { column: number; top: number };

/**
 * Each card, in order, under the column that is shortest so far, by the
 * cards' heights and the gap under each, and how tall the wall then is. A card
 * not measured yet counts as no height, so unmeasured cards are dealt out in
 * turn. A card measured at no height renders nothing: it takes no place and no
 * gap.
 */
export function wallPlaces(
  heights: readonly (number | undefined)[],
  count: number,
  gap: number,
): { places: WallPlace[]; height: number } {
  const tall = Array.from({ length: count }, () => 0);
  const places = heights.map((height): WallPlace => {
    const column = tall.indexOf(Math.min(...tall));
    const top = tall[column] ?? 0;
    if (height !== 0) tall[column] = top + (height ?? 0) + gap;
    return { column, top };
  });
  return { places, height: Math.max(0, Math.max(...tall) - gap) };
}
