/**
 * Tells the studio command what went wrong in the page, so the builder's terminal, and
 * `theorem-studio errors`, see what the builder saw. Only the studio's own page does this: its
 * project's server keeps the page's errors with the rest of what happened.
 *
 * @module
 */

/** The longest error the page sends; the server refuses more. */
const SENT_CAP = 4000;

/** What an error says, with where it came from when the browser knows. */
export function errorText(error: unknown): string {
  if (error instanceof Error) {
    const where = error.stack?.split('\n').find((line) => line.includes('at '));
    return `${error.name}: ${error.message}${where ? ` (${where.trim()})` : ''}`;
  }
  return String(error);
}

/** Sends `text` to the project's server at `endpoint`. Never throws: a page that cannot tell, does not. */
export function tellServer(endpoint: string, text: string): void {
  fetch(`${endpoint}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.slice(0, SENT_CAP) }),
    keepalive: true,
  }).catch(() => {});
}

/** Sends each error the page does not catch, and each promise nothing waits on that fails. */
export function reportPageErrors(endpoint: string): void {
  addEventListener('error', (event) =>
    tellServer(endpoint, errorText(event.error ?? event.message)),
  );
  addEventListener('unhandledrejection', (event) => tellServer(endpoint, errorText(event.reason)));
}
