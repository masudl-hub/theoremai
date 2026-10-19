/**
 * Loads `modules` once the page is idle, so a panel or runner the builder opens later does not
 * wait on the network, and nothing the first paint needs waits on them.
 */
export function warmWhenIdle(...modules: (() => Promise<unknown>)[]) {
  const warm = () => {
    for (const load of modules) load().catch(() => {});
  };
  if (globalThis.requestIdleCallback) globalThis.requestIdleCallback(warm);
  else globalThis.setTimeout(warm, 1);
}
