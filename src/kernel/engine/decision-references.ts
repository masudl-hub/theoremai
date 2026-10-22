import type { DecisionAsset } from '../types.ts';

/** A run of text, or the image a reference in it stands for. */
export type ReferencePiece = string | { reference: string; asset: DecisionAsset };

/**
 * A string split at the image references in it, as TypeSafe reads them: a string that is exactly a
 * reference is that image; otherwise references match as plain text, left to right, never
 * overlapping, the longest where two start together. A string with no reference comes back whole.
 */
export function splitReferences(
  text: string,
  assets: Record<string, DecisionAsset>,
): ReferencePiece[] {
  if (Object.hasOwn(assets, text))
    return [{ reference: text, asset: assets[text] as DecisionAsset }];
  const references = Object.keys(assets);
  const pieces: ReferencePiece[] = [];
  let from = 0;
  while (from < text.length) {
    let at = -1;
    let found = '';
    for (const reference of references) {
      const index = text.indexOf(reference, from);
      if (index < 0) continue;
      if (at < 0 || index < at || (index === at && reference.length > found.length)) {
        at = index;
        found = reference;
      }
    }
    if (at < 0) break;
    if (at > from) pieces.push(text.slice(from, at));
    pieces.push({ reference: found, asset: assets[found] as DecisionAsset });
    from = at + found.length;
  }
  if (from < text.length) pieces.push(text.slice(from));
  return pieces;
}

/** Every string value in a JSON value, keys left out: the only places a reference is read. */
export function* stringValues(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const item of value) yield* stringValues(item);
  else if (value !== null && typeof value === 'object')
    for (const item of Object.values(value)) yield* stringValues(item);
}

/** The images the strings of `values` reference, in the order of `assets`. */
export function referencedAssets(
  values: readonly unknown[],
  assets: Record<string, DecisionAsset>,
): Record<string, DecisionAsset> {
  const used = new Set<string>();
  for (const value of values)
    for (const text of stringValues(value))
      for (const piece of splitReferences(text, assets))
        if (typeof piece !== 'string') used.add(piece.reference);
  return Object.fromEntries(Object.entries(assets).filter(([reference]) => used.has(reference)));
}
