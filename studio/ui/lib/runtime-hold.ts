/** A runtime's abort, and how many mounted effects hold it. */
export interface RuntimeHold {
  controller: AbortController;
  holds: number;
}

/**
 * A hold on `held` for one effect run; the cleanup it returns lets go, and the runtime's runs
 * abort once nothing holds it.
 * why: in development, StrictMode runs each effect's cleanup and then its setup again at once,
 * while the memo keeps the same runtime. Aborting in that cleanup left the page on a dead signal,
 * so every run failed with "signal is aborted without reason". The abort waits a microtask, and
 * the setup that comes straight back takes the hold again first.
 */
export function holdRuntime(held: RuntimeHold): () => void {
  held.holds++;
  return () => {
    held.holds--;
    queueMicrotask(() => {
      if (held.holds === 0) held.controller.abort();
    });
  };
}
