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

import type { ToolGateAuth } from '../../../src/interface/mod.ts';
import type {
	ToolGate,
	ToolId,
	TurnInput,
	TurnToolSnapshot,
} from '../../../src/kernel/mod.ts';

/** A tool call the kernel paused on a gate, as the server saw it. */
export type PendingToolGate = {
	name: string;
	input: unknown;
	/** The gate, and for a sign-in gate the credential slot and kind it waits for. */
	gate: Pick<ToolGate, 'kind' | 'permission'> & { auth?: ToolGateAuth };
	snapshot?: TurnToolSnapshot;
	promoted: ToolId[];
	turnInput: TurnInput;
	model?: string;
	createdAt: number;
};

export type TheoremSessionState = {
	/** Tool ids the user allowed for the rest of this session. */
	permissions: string[];
	/** Paused tool calls by call id — the only calls `/invoke` will run. */
	gates: Record<string, PendingToolGate>;
	/** Provider interaction ids this session produced, newest last. */
	interactions: string[];
};

/**
 * Where session state lives. The default is process memory — use a shared
 * store (KV, Redis, a database row) when requests can reach different instances.
 */
export interface TheoremSessionStore {
	load(sessionId: string): TheoremSessionState | undefined | Promise<TheoremSessionState | undefined>;
	save(sessionId: string, state: TheoremSessionState): void | Promise<void>;
}

const GATE_TTL_MS = 30 * 60 * 1000;

export function emptySessionState(): TheoremSessionState {
	return { permissions: [], gates: {}, interactions: [] };
}

/** Drop expired gates. */
export function pruneGates(
	gates: Record<string, PendingToolGate>,
	now: number,
): Record<string, PendingToolGate> {
	return Object.fromEntries(
		Object.entries(gates).filter(([, gate]) => now - gate.createdAt < GATE_TTL_MS),
	);
}

export type MemorySessionStoreOptions = {
	/** Idle sessions are forgotten after this long. Default 24h. */
	ttlMs?: number;
	/** Oldest sessions are evicted past this count. Default 10 000. */
	maxSessions?: number;
};

/** A per-session value kept in process memory: forgotten when idle, oldest evicted first. */
export type MemorySessionMap<T> = {
	load(sessionId: string): T | undefined;
	save(sessionId: string, value: T): void;
};

export function createMemorySessionMap<T>(options: MemorySessionStoreOptions = {}): MemorySessionMap<T> {
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

export function createMemorySessionStore(options: MemorySessionStoreOptions = {}): TheoremSessionStore {
	return createMemorySessionMap<TheoremSessionState>(options);
}
