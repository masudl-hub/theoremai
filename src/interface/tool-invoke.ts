import { extractLoadedIds } from '../kernel/tools/resolve.ts';
import type { ToolId, TurnEvent, TurnToolSnapshot } from '../kernel/types.ts';
import { findLast } from '../kernel/util/find-last.ts';

/** The ids of the tools a turn loaded, read from the loaded ids in its completed tool events. */
function promotedToolIdsFromEvents(events: readonly TurnEvent[]): ToolId[] {
  const ids = new Set<ToolId>();
  for (const event of events) {
    if (event.type !== 'tool' || event.tool.phase !== 'complete') {
      continue;
    }
    for (const id of extractLoadedIds(event.tool.output) ?? []) {
      ids.add(id);
    }
  }
  return [...ids];
}

/** The tool snapshot on the last `done` event that carries one, which only a turn stopped on a tool or gate does. */
function toolSnapshotFromEvents(events: readonly TurnEvent[]): TurnToolSnapshot | undefined {
  // why: Only a `done` that stopped on `tool` or `gate` carries one (`DoneEvent`).
  const done = findLast(events, (event) => event.type === 'done' && event.tools !== undefined);
  return done?.type === 'done' ? done.tools : undefined;
}

/** What a reply that goes on after a pause carries into its next run. */
export type ReplyCarried = { promoted: ToolId[]; stepsTaken: number };

/**
 * What a paused reply holds: the tools on the list it paused with, those a call has loaded since,
 * and the steps its last run counted.
 */
function replyCarriedFromEvents(events: readonly TurnEvent[]): ReplyCarried {
  const visible = toolSnapshotFromEvents(events)?.visible ?? [];
  const done = findLast(events, (event) => event.type === 'done' && event.steps !== undefined);
  return {
    promoted: [...new Set([...visible, ...promotedToolIdsFromEvents(events)])],
    stepsTaken: done?.type === 'done' ? (done.steps ?? 0) : 0,
  };
}

export { promotedToolIdsFromEvents, replyCarriedFromEvents, toolSnapshotFromEvents };
