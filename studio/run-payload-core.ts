/** No package imports; typed wrappers live in `run-payload.ts`. */

export const STUDIO_RUN_PAYLOAD_KEY = 'theoremjs.studio.run';

export const STUDIO_RUN_PAYLOAD_KEY_PREFIX = `${STUDIO_RUN_PAYLOAD_KEY}.`;

/** Ordered index of saved run ids (newest first). */
export const STUDIO_RUN_INDEX_KEY = `${STUDIO_RUN_PAYLOAD_KEY}.index`;

export const STUDIO_RUN_PAYLOAD_CAP = 8;

export type StudioRunIndexEntry = {
	id: string;
	savedAt: number;
};

export type StudioRunIndex = {
	entries: StudioRunIndexEntry[];
};

export function studioRunPayloadKey(runId: string): string {
	return `${STUDIO_RUN_PAYLOAD_KEY_PREFIX}${runId}`;
}

export function createStudioRunId(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
		return crypto.randomUUID();
	}
	return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function readStudioRunIdFromUrl(
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

export function upsertStudioRunIndex(
	entries: readonly StudioRunIndexEntry[],
	runId: string,
	savedAt: number,
	cap: number = STUDIO_RUN_PAYLOAD_CAP,
): { entries: StudioRunIndexEntry[]; prunedIds: string[] } {
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

function readIndex(store: Storage): StudioRunIndexEntry[] {
	const raw = store.getItem(STUDIO_RUN_INDEX_KEY);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as StudioRunIndex;
		return Array.isArray(parsed.entries) ? parsed.entries : [];
	} catch {
		return [];
	}
}

function writeIndex(store: Storage, entries: StudioRunIndexEntry[]): void {
	store.setItem(STUDIO_RUN_INDEX_KEY, JSON.stringify({ entries } satisfies StudioRunIndex));
}

/** Prunes the oldest payloads beyond the cap. */
export function saveStudioRunPayloadRecord(
	payload: Record<string, unknown>,
	runId: string,
	storeOverride?: Storage | null,
): void {
	const store = resolveStore(storeOverride);
	if (!store || !runId) return;
	store.removeItem(STUDIO_RUN_PAYLOAD_KEY);
	const body = {
		version: 1,
		...payload,
		runId,
	};
	store.setItem(studioRunPayloadKey(runId), JSON.stringify(body));
	const { entries, prunedIds } = upsertStudioRunIndex(
		readIndex(store),
		runId,
		Date.now(),
		STUDIO_RUN_PAYLOAD_CAP,
	);
	for (const id of prunedIds) {
		store.removeItem(studioRunPayloadKey(id));
	}
	writeIndex(store, entries);
}

export function loadStudioRunPayloadRecord(
	runId: string,
	storeOverride?: Storage | null,
): Record<string, unknown> | null {
	const store = resolveStore(storeOverride);
	if (!store || !runId) return null;
	const raw = store.getItem(studioRunPayloadKey(runId));
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** Every kept run's id, indexed or not. */
export function keptStudioRunIds(storeOverride?: Storage | null): string[] {
	const store = resolveStore(storeOverride);
	if (!store) return [];
	const ids: string[] = [];
	for (let i = 0; i < store.length; i++) {
		const key = store.key(i);
		if (key?.startsWith(STUDIO_RUN_PAYLOAD_KEY_PREFIX) && key !== STUDIO_RUN_INDEX_KEY)
			ids.push(key.slice(STUDIO_RUN_PAYLOAD_KEY_PREFIX.length));
	}
	return ids;
}

export function clearStudioRunPayloadRecord(
	runId: string,
	storeOverride?: Storage | null,
): void {
	const store = resolveStore(storeOverride);
	if (!store || !runId) return;
	store.removeItem(studioRunPayloadKey(runId));
	writeIndex(
		store,
		readIndex(store).filter((entry) => entry.id !== runId),
	);
}
