/**
 * Sessions for MCP servers that refuse a call without one. A session is a cache, not state: it
 * lives in memory on one tool registry, is never persisted, and losing it costs one reopen.
 */

const MAX_SESSIONS = 256;
const IDLE_MS = 30 * 60 * 1000;
// The spec allows visible ASCII only; the cap keeps a server from bloating every later request.
const SESSION_ID = /^[\x21-\x7E]{1,256}$/;

export type McpSession = { id: string; protocolVersion: string };

export interface McpSessionCache {
  get(key: string): McpSession | undefined;
  /** Parallel callers for one key share a single `open`. */
  open(key: string, open: () => Promise<McpSession>): Promise<McpSession>;
  /** Only drops the session if it's still `id`, so a late expiry can't evict a newer one. */
  drop(key: string, id: string): void;
  clear(): void;
}

export function createMcpSessionCache(now: () => number = Date.now): McpSessionCache {
  const sessions = new Map<string, McpSession & { usedAt: number }>();
  const pending = new Map<string, Promise<McpSession>>();
  return {
    get(key) {
      const entry = sessions.get(key);
      if (!entry) return undefined;
      sessions.delete(key);
      if (now() - entry.usedAt > IDLE_MS) return undefined;
      // Re-inserting keeps the map in least-recently-used order for eviction.
      sessions.set(key, { ...entry, usedAt: now() });
      return { id: entry.id, protocolVersion: entry.protocolVersion };
    },
    open(key, open) {
      const inFlight = pending.get(key);
      if (inFlight) return inFlight;
      const opening = open()
        .then((session) => {
          sessions.delete(key);
          sessions.set(key, { ...session, usedAt: now() });
          for (const oldest of sessions.keys()) {
            if (sessions.size <= MAX_SESSIONS) break;
            sessions.delete(oldest);
          }
          return session;
        })
        .finally(() => pending.delete(key));
      pending.set(key, opening);
      return opening;
    },
    drop(key, id) {
      if (sessions.get(key)?.id === id) sessions.delete(key);
    },
    clear() {
      sessions.clear();
      pending.clear();
    },
  };
}

export function isMcpSessionId(value: string | null): value is string {
  return value !== null && SESSION_ID.test(value);
}

/** One session per server and credential; the credential is hashed, never kept. */
export async function mcpSessionKey(url: string, headers: Record<string, string>): Promise<string> {
  const canonical = JSON.stringify(
    Object.entries(headers)
      .map(([name, value]): [string, string] => [name.toLowerCase(), value])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0'));
  return `${url}\n${hex.join('')}`;
}
