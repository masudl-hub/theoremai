/**
 * Pure / storage helpers for playground run handoff (no package imports).
 * Typed wrappers live in `run-payload.ts`.
 *
 * @module
 */

/** Legacy single-slot key (removed on save). */
export const PLAYGROUND_RUN_PAYLOAD_KEY = 'theorum.playground.run';

/** Prefix for per-run payload keys: `${prefix}${runId}`. */
export const PLAYGROUND_RUN_PAYLOAD_KEY_PREFIX = `${PLAYGROUND_RUN_PAYLOAD_KEY}.`;

/** Ordered index of saved run ids (newest first). */
export const PLAYGROUND_RUN_INDEX_KEY = `${PLAYGROUND_RUN_PAYLOAD_KEY}.index`;

/** Max retained run payloads in localStorage. */
export const PLAYGROUND_RUN_PAYLOAD_CAP = 8;

export type PlaygroundRunIndexEntry = {
	id: string;
	savedAt: number;
};

export type PlaygroundRunIndex = {
	entries: PlaygroundRunIndexEntry[];
};

/** Storage key for one run payload. */
export function playgroundRunPayloadKey(runId: string): string {
	return `${PLAYGROUND_RUN_PAYLOAD_KEY_PREFIX}${runId}`;
}

/** Create a new run id (crypto UUID when available). */
export function createPlaygroundRunId(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
		return crypto.randomUUID();
	}
	return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Read `?run=` from a URL string or Location. */
export function readPlaygroundRunIdFromUrl(
	url: string | { href: string } = typeof window !== 'undefined' ? globalThis.location : { href: '' },
): string | null {
	const href = typeof url === 'string' ? url : url.href;
	if (!href) return null;
	try {
		const parsed = new URL(href, 'http://localhost');
		const run = parsed.searchParams.get('run')?.trim();
		return run && run.length > 0 ? run : null;
	} catch {
		return null;
	}
}

/** Pure: merge a saved id into the index (newest first) and return ids to delete. */
export function upsertPlaygroundRunIndex(
	entries: readonly PlaygroundRunIndexEntry[],
	runId: string,
	savedAt: number,
	cap: number = PLAYGROUND_RUN_PAYLOAD_CAP,
): { entries: PlaygroundRunIndexEntry[]; prunedIds: string[] } {
	const without = entries.filter((entry) => entry.id !== runId);
	const next = [{ id: runId, savedAt }, ...without];
	if (next.length <= cap) {
		return { entries: next, prunedIds: [] };
	}
	const kept = next.slice(0, cap);
	const prunedIds = next.slice(cap).map((entry) => entry.id);
	return { entries: kept, prunedIds };
}

function resolveStore(store?: Storage | null): Storage | null {
	if (store !== undefined) return store;
	if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) return null;
	try {
		// Private-mode / blocked storage can throw on access.
		return globalThis.localStorage;
	} catch {
		return null;
	}
}

function readIndex(store: Storage): PlaygroundRunIndexEntry[] {
	const raw = store.getItem(PLAYGROUND_RUN_INDEX_KEY);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as PlaygroundRunIndex;
		return Array.isArray(parsed.entries) ? parsed.entries : [];
	} catch {
		return [];
	}
}

function writeIndex(store: Storage, entries: PlaygroundRunIndexEntry[]): void {
	store.setItem(PLAYGROUND_RUN_INDEX_KEY, JSON.stringify({ entries } satisfies PlaygroundRunIndex));
}

/** Persist a JSON payload for `runId`; prune oldest beyond the cap. */
export function savePlaygroundRunPayloadRecord(
	payload: Record<string, unknown>,
	runId: string,
	storeOverride?: Storage | null,
): void {
	const store = resolveStore(storeOverride);
	if (!store || !runId) return;
	store.removeItem(PLAYGROUND_RUN_PAYLOAD_KEY);
	const body = {
		version: 1,
		...payload,
		runId,
	};
	store.setItem(playgroundRunPayloadKey(runId), JSON.stringify(body));
	const { entries, prunedIds } = upsertPlaygroundRunIndex(
		readIndex(store),
		runId,
		Date.now(),
		PLAYGROUND_RUN_PAYLOAD_CAP,
	);
	for (const id of prunedIds) {
		store.removeItem(playgroundRunPayloadKey(id));
	}
	writeIndex(store, entries);
}

/** Load a JSON payload for `runId`. */
export function loadPlaygroundRunPayloadRecord(
	runId: string,
	storeOverride?: Storage | null,
): Record<string, unknown> | null {
	const store = resolveStore(storeOverride);
	if (!store || !runId) return null;
	const raw = store.getItem(playgroundRunPayloadKey(runId));
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** Remove one run payload and its index entry. */
export function clearPlaygroundRunPayloadRecord(
	runId: string,
	storeOverride?: Storage | null,
): void {
	const store = resolveStore(storeOverride);
	if (!store || !runId) return;
	store.removeItem(playgroundRunPayloadKey(runId));
	writeIndex(
		store,
		readIndex(store).filter((entry) => entry.id !== runId),
	);
}
