import type { TraceRecord } from '@theoremjs/agents';
import type { TraceFeed } from '@theoremjs/web/client';
import { useSyncExternalStore } from 'react';

const NONE: readonly TraceRecord[] = [];
const noSubscription = () => () => {};

/** The records a feed has delivered so far; none without a feed. */
export function useTraceRecords(feed: TraceFeed | undefined): readonly TraceRecord[] {
  return useSyncExternalStore(feed?.subscribe ?? noSubscription, feed?.records ?? (() => NONE));
}
