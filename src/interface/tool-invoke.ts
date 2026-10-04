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
  // Only a `done` that stopped on `tool` or `gate` carries one (`DoneEvent`).
  const done = findLast(events, (event) => event.type === 'done' && event.tools !== undefined);
  return done?.type === 'done' ? done.tools : undefined;
}

export { promotedToolIdsFromEvents, toolSnapshotFromEvents };
