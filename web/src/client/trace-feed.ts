import type { TraceRecord } from '@theoremjs/agents';

/**
 * Trace records a host sends back to the client, in arrival order. Only a host
 * that delivers its traces (the studio) has one; `useTraceRecords` reads it.
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

/** A feed already holding `records` — a recording opened for View Trace. */
export function recordedFeed(records: readonly TraceRecord[]): TraceFeed {
  const feed = createTraceFeed();
  for (const record of records) feed.push(record);
  return feed;
}
