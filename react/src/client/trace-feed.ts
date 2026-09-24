import type { TraceRecord } from '../../../mod.ts';

/**
 * Trace records a host sends back to the client, in arrival order. Only a host
 * that delivers its traces (the playground) has one; `useTraceRecords` reads it.
 */
export interface TraceFeed {
	push(record: TraceRecord): void;
	/** The records so far; a new array after every push. */
	records(): readonly TraceRecord[];
	/** Called after every push; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
}

export function createTraceFeed(): TraceFeed {
	let records: readonly TraceRecord[] = [];
	const listeners = new Set<() => void>();
	return {
		push(record) {
			records = [...records, record];
			for (const listener of listeners) listener();
		},
		records: () => records,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
