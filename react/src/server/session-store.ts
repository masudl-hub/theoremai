/**
 * Server-held session state for `createTheoremHandler`.
 *
 * Everything that grants authority lives here, never in the request body:
 * which tools the user allowed for the session, which paused tool calls may be
 * resumed (and with exactly what input), and which provider interactions this
 * session may continue.
 *
 * @module
 */

import type { ToolGateAuth } from '@theoremjs/agents/interface';
import type {
  ToolGate,
  ToolId,
  TurnEventOf,
  TurnInput,
  TurnToolSnapshot,
} from '@theoremjs/agents/kernel';
import { gateExpired } from '@theoremjs/agents/kernel';

/** A tool call the kernel paused on a gate, as the server saw it. */
export type PendingToolGate = {
  name: string;
  /** The model's arguments; an approval runs the call with exactly these. */
  arguments: Record<string, unknown>;
  /** The gate, and for a sign-in gate the credential slot and kind it waits for. */
  gate: Pick<ToolGate, 'kind' | 'permission'> & { auth?: ToolGateAuth };
  snapshot?: TurnToolSnapshot;
  promoted: ToolId[];
  turnInput: TurnInput;
  model?: string;
  createdAt: number;
};

/**
 * A paused call the server answered, and the event that settled it. A client
 * the stream never reached still shows the call waiting; a message that walks
 * away from it gets this answer again, not a refusal.
 */
export type SettledToolGate = {
  event: TurnEventOf<'tool'>;
  /** When the call paused: a settled call is kept as long as its gate would have waited. */
  createdAt: number;
};

export type TheoremSessionState = {
  /** Tool ids the user allowed for the rest of this session. */
  permissions: string[];
  /** Paused tool calls by call id — the only calls `/invoke` will run. */
  gates: Record<string, PendingToolGate>;
  /** Paused calls the server answered and settled, by call id. */
  settled: Record<string, SettledToolGate>;
  /** Checkpoint identities this session produced, newest last. */
  providerCheckpoints: string[];
};

/**
 * Where session state lives. The default is process memory — use a shared
 * store (KV, Redis, a database row) when requests can reach different instances.
 */
export interface TheoremSessionStore {
  load(
    sessionId: string,
  ): TheoremSessionState | undefined | Promise<TheoremSessionState | undefined>;
  save(sessionId: string, state: TheoremSessionState): void | Promise<void>;
}

export function emptySessionState(): TheoremSessionState {
  return { permissions: [], gates: {}, settled: {}, providerCheckpoints: [] };
}

/** Drop gates (waiting or settled) older than `ttlMs`. */
export function pruneGates<Gate extends { createdAt: number }>(
  gates: Record<string, Gate>,
  now: number,
  ttlMs: number,
): Record<string, Gate> {
  return Object.fromEntries(
    Object.entries(gates).filter(([, gate]) => !gateExpired(gate.createdAt, now, ttlMs)),
  );
}

export type MemorySessionStoreOptions = {
  /** Idle sessions are forgotten after this long. Default 24h. */
  ttlMs?: number;
  /** Oldest sessions are evicted past this count. Default 10 000. */
  maxSessions?: number;
};

/** A value kept per session id; the shape of every store the handler takes. */
export type PerSessionStore<T> = {
  load(sessionId: string): T | undefined | Promise<T | undefined>;
  save(sessionId: string, value: T): void | Promise<void>;
};

/** A per-session value kept in process memory: forgotten when idle, oldest evicted first. */
export function createMemorySessionMap<T>(
  options: MemorySessionStoreOptions = {},
): PerSessionStore<T> {
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const maxSessions = options.maxSessions ?? 10_000;
  const sessions = new Map<string, { value: T; touched: number }>();
  return {
    load(sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) return undefined;
      if (Date.now() - entry.touched > ttlMs) {
        sessions.delete(sessionId);
        return undefined;
      }
      return structuredClone(entry.value);
    },
    save(sessionId, value) {
      sessions.delete(sessionId);
      sessions.set(sessionId, { value: structuredClone(value), touched: Date.now() });
      while (sessions.size > maxSessions) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
    },
  };
}

export function createMemorySessionStore(
  options: MemorySessionStoreOptions = {},
): TheoremSessionStore {
  return createMemorySessionMap<TheoremSessionState>(options);
}
