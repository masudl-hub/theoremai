/** Lower-case `type/subtype`, parameters removed. */
export function mimeEssence(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}
