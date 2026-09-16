/**
 * Host tool invoke context derived from turn events — snapshot and T2 promotions.
 *
 * @module
 */

import type { ToolId, TurnEvent, TurnToolSnapshot } from '../kernel/types.ts';
import { findLast } from '../kernel/util/find-last.ts';

/** Collect T2 ids promoted by loader tool completions in a turn event stream. */
function promotedToolIdsFromEvents(events: readonly TurnEvent[]): ToolId[] {
  const ids = new Set<ToolId>();
  for (const event of events) {
    if (
      event.type !== 'tool' ||
      event.tool?.phase !== 'complete' ||
      event.tool.output === undefined
    ) {
      continue;
    }
    const loaded = (event.tool.output as { loaded?: unknown }).loaded;
    if (!Array.isArray(loaded)) {
      continue;
    }
    for (const id of loaded) {
      if (typeof id === 'string') {
        ids.add(id);
      }
    }
  }
  return [...ids];
}

/** Read the turn tool snapshot emitted on a gate (or legacy tool-pause) terminal `done`. */
function toolSnapshotFromEvents(events: readonly TurnEvent[]): TurnToolSnapshot | undefined {
  const done = findLast(
    events,
    (event) =>
      event.type === 'done' && (event.stop?.kind === 'gate' || event.stop?.kind === 'tool'),
  );
  return done?.tools;
}

export { promotedToolIdsFromEvents, toolSnapshotFromEvents };
