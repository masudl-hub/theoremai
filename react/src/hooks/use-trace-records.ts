import { useSyncExternalStore } from 'react';
import type { TraceRecord } from '../../../mod.ts';
import type { TraceFeed } from '../client/trace-feed.ts';

const NONE: readonly TraceRecord[] = [];
const noSubscription = () => () => {};

/** The records a feed has delivered so far; none without a feed. */
export function useTraceRecords(feed: TraceFeed | undefined): readonly TraceRecord[] {
	return useSyncExternalStore(feed?.subscribe ?? noSubscription, feed?.records ?? (() => NONE));
}
