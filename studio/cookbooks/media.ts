/**
 * Portable `media` hooks for cookbook HTTP tools. Functions cannot cross JSON in
 * `StudioRunPayload`, so `registerCustomTool` attaches the matching hook by
 * tool name when the draft runs.
 *
 * @module
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The string at `path` in `output`, or nothing. */
function at(output: unknown, path: readonly string[]): string | undefined {
  let value: unknown = output;
  for (const key of path) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return typeof value === 'string' && value ? value : undefined;
}

function picture(...path: string[]): MediaHook {
  return (output) => {
    const url = at(output, path);
    return url ? [{ url, sent: true }] : [];
  };
}

/** A picture the kernel fetches for the model to look at, and shows the person. */
type MediaHook = (output: unknown) => { url: string; sent: true }[];

const COOKBOOK_TOOL_MEDIA: Readonly<Record<string, MediaHook>> = {
  random_dog_image: picture('message'),
  wikipedia_summary: picture('originalimage', 'source'),
  get_pokemon: picture('sprites', 'other', 'official-artwork', 'front_default'),
};

/** The cookbook `media` hook for `name`, when that tool returns a picture. */
export function cookbookToolMedia(
  name: string,
): ((output: unknown) => { url: string; sent: true }[]) | undefined {
  return COOKBOOK_TOOL_MEDIA[name];
}
