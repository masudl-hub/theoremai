/**
 * The media a tool returned that the chat shows: `sent`, what the tool sent to the person (a
 * consumer chat); `all`, every piece the model read as well (an evaluation view). Media a model
 * generated and files a person attached always show.
 */
export type ToolMediaShown = 'sent' | 'all';

/** Whether a tool's piece of media shows under `shown`: under `sent`, only what the tool sent. */
export function toolMediaShows(
  block: { fromTool?: true; sent?: true },
  shown: ToolMediaShown,
): boolean {
  return shown === 'all' || !block.fromTool || block.sent === true;
}

/** The last segment of a reference, the name it reads as; the whole reference when it has none. */
export function mediaFileName(uri: string): string {
  const path = uri.split(/[?#]/)[0] ?? uri;
  const last = path.split('/').filter(Boolean).at(-1);
  try {
    return last ? decodeURIComponent(last) : uri;
  } catch {
    return last ?? uri;
  }
}
