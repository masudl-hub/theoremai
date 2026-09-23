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
	gate: Pick<ToolGate, 'kind' | 'permission'>;
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

const MAX_PENDING_GATES = 32;
export const MAX_INTERACTIONS = 256;
const GATE_TTL_MS = 30 * 60 * 1000;

export function emptySessionState(): TheoremSessionState {
	return { permissions: [], gates: {}, interactions: [] };
}

/** Drop expired gates and keep the newest `MAX_PENDING_GATES`. */
export function pruneGates(
	gates: Record<string, PendingToolGate>,
	now: number,
): Record<string, PendingToolGate> {
	const live = Object.entries(gates)
		.filter(([, gate]) => now - gate.createdAt < GATE_TTL_MS)
		.sort(([, a], [, b]) => a.createdAt - b.createdAt)
		.slice(-MAX_PENDING_GATES);
	return Object.fromEntries(live);
}

export type MemorySessionStoreOptions = {
	/** Idle sessions are forgotten after this long. Default 24h. */
	ttlMs?: number;
	/** Oldest sessions are evicted past this count. Default 10 000. */
	maxSessions?: number;
};

export function createMemorySessionStore(options: MemorySessionStoreOptions = {}): TheoremSessionStore {
	const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
	const maxSessions = options.maxSessions ?? 10_000;
	const sessions = new Map<string, { state: TheoremSessionState; touched: number }>();
	return {
		load(sessionId) {
			const entry = sessions.get(sessionId);
			if (!entry) return undefined;
			if (Date.now() - entry.touched > ttlMs) {
				sessions.delete(sessionId);
				return undefined;
			}
			return structuredClone(entry.state);
		},
		save(sessionId, state) {
			sessions.delete(sessionId);
			sessions.set(sessionId, { state: structuredClone(state), touched: Date.now() });
			while (sessions.size > maxSessions) {
				const oldest = sessions.keys().next().value;
				if (oldest === undefined) break;
				sessions.delete(oldest);
			}
		},
	};
}
