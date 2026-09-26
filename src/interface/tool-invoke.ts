/**
 * Host tool invoke context derived from turn events — snapshot and T2 promotions.
 *
 * @module
 */

import { extractLoadedIds } from '../kernel/tools/resolve.ts';
import type { ToolId, TurnEvent, TurnToolSnapshot } from '../kernel/types.ts';
import { findLast } from '../kernel/util/find-last.ts';

/** Collect T2 ids promoted by loader tool completions in a turn event stream. */
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

/** Read the turn tool snapshot emitted on a gate (or legacy tool-pause) terminal `done`. */
function toolSnapshotFromEvents(events: readonly TurnEvent[]): TurnToolSnapshot | undefined {
  // Only a `done` that stopped on `tool` or `gate` carries one (`DoneEvent`).
  const done = findLast(events, (event) => event.type === 'done' && event.tools !== undefined);
  return done?.type === 'done' ? done.tools : undefined;
}

export { promotedToolIdsFromEvents, toolSnapshotFromEvents };
