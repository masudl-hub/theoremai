/**
 * Where a session's open pages hear that a background call ended. The line carries no content: a
 * page that hears it reads the conversation, so one read decides what a reader sees.
 *
 * @module
 */

/**
 * Keyed by session id. The default lives in process memory, which reaches only pages connected to
 * the process that ran the call. Bring a shared one (Redis, a Durable Object) for several instances.
 */
export interface TheoremNotifier {
  /** Calls `changed` for each `publish` under `sessionId`, until the returned function runs. */
  subscribe(sessionId: string, changed: () => void): (() => void) | Promise<() => void>;
  publish(sessionId: string): void | Promise<void>;
}

export function createMemoryNotifier(): TheoremNotifier {
  const listeners = new Map<string, Set<() => void>>();
  return {
    subscribe(sessionId, changed) {
      const listening = listeners.get(sessionId) ?? new Set();
      listeners.set(sessionId, listening);
      listening.add(changed);
      return () => {
        listening.delete(changed);
        if (listening.size === 0 && listeners.get(sessionId) === listening)
          listeners.delete(sessionId);
      };
    },
    publish(sessionId) {
      for (const changed of [...(listeners.get(sessionId) ?? [])]) changed();
    },
  };
}
