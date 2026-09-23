/**
 * MIME value parsing.
 *
 * @module
 */

/** A MIME value's lower-case `type/subtype`, parameters removed. */
export function mimeEssence(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}
