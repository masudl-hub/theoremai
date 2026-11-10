import type { ResolveMedia, ToolMediaShown } from '@theoremjs/react/ui';

/**
 * The studio shows every piece of media a tool returned, what the model read as well as what it
 * sent, and loads a reference only when it is a plain web address; any other shows as the file it names.
 */
export const STUDIO_TOOL_MEDIA: ToolMediaShown = 'all';

/** A reference the studio can load as it stands: an http(s) address. */
export const studioResolveMedia: ResolveMedia = (reference) =>
  /^https?:\/\//i.test(reference.uri) ? reference.uri : null;
