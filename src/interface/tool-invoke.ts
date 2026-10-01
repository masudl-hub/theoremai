import { extractLoadedIds } from '../kernel/tools/resolve.ts';
import type { ToolId, TurnEvent, TurnToolSnapshot } from '../kernel/types.ts';
import { findLast } from '../kernel/util/find-last.ts';

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

function toolSnapshotFromEvents(events: readonly TurnEvent[]): TurnToolSnapshot | undefined {
  // Only a `done` that stopped on `tool` or `gate` carries one (`DoneEvent`).
  const done = findLast(events, (event) => event.type === 'done' && event.tools !== undefined);
  return done?.type === 'done' ? done.tools : undefined;
}

export { promotedToolIdsFromEvents, toolSnapshotFromEvents };
