/**
 * Watching the project's files from the page: the local server says when the builder's editor
 * writes one. Whether the builder wants that is a preference, in `studio-prefs.ts`.
 */

/**
 * Listens for the files the server says changed. `onOpen` runs when the server is watching: one
 * started with `--no-watch` never opens. Answers how to stop listening.
 */
export function subscribeToFiles(
  endpoint: string,
  on: { open: () => void; files: (files: string[]) => void },
): () => void {
  if (typeof EventSource === 'undefined') return () => undefined;
  const source = new EventSource(`${endpoint}/watch`);
  source.onopen = on.open;
  source.onmessage = (event: MessageEvent<string>) => {
    try {
      const told: unknown = JSON.parse(event.data);
      const files =
        typeof told === 'object' && told !== null && 'files' in told ? told.files : undefined;
      on.files(Array.isArray(files) ? files.filter((file) => typeof file === 'string') : []);
    } catch {
      on.files([]);
    }
  };
  return () => {
    source.close();
  };
}
