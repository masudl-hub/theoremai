/**
 * How someone left the map, kept in this tab's records beside the workspace, a project's
 * under its own name: where they dragged its nodes, with and without detail, whether it shows
 * detail, and the node whose family alone it shows.
 */
import type { MapPlace } from '../../mod.ts';
import { isRecord, session, WORKSPACE_KEY } from './studio-session.ts';

export type MapPlaces = Readonly<Record<string, MapPlace>>;

export interface KeptMap {
  tokens: MapPlaces;
  detail: MapPlaces;
  expanded: boolean;
  family?: string;
}

const NOTHING_KEPT: KeptMap = { tokens: {}, detail: {}, expanded: false };

const keptKey = (project: string | undefined) =>
  project === undefined ? `${WORKSPACE_KEY}.map` : `${WORKSPACE_KEY}.map.project:${project}`;

function places(kept: unknown): MapPlaces {
  if (!isRecord(kept)) return {};
  const read: Record<string, MapPlace> = {};
  for (const [id, place] of Object.entries(kept)) {
    if (isRecord(place) && typeof place.x === 'number' && typeof place.y === 'number') {
      read[id] = { x: place.x, y: place.y };
    }
  }
  return read;
}

/** What was kept; the map as it first opens when nothing was or it cannot be read. */
export function readKeptMap(project: string | undefined): KeptMap {
  try {
    const kept: unknown = JSON.parse(session()?.getItem(keptKey(project)) ?? 'null');
    if (!isRecord(kept)) return NOTHING_KEPT;
    return {
      tokens: places(kept.tokens),
      detail: places(kept.detail),
      expanded: kept.expanded === true,
      ...(typeof kept.family === 'string' ? { family: kept.family } : {}),
    };
  } catch {
    return NOTHING_KEPT;
  }
}

/** Keeps `kept`, or forgets it when it is the map as it first opens. */
export function writeKeptMap(project: string | undefined, kept: KeptMap): void {
  const { tokens, detail, expanded, family } = kept;
  const untouched =
    Object.keys(tokens).length === 0 &&
    Object.keys(detail).length === 0 &&
    !expanded &&
    family === undefined;
  if (untouched) session()?.removeItem(keptKey(project));
  else session()?.setItem(keptKey(project), JSON.stringify(kept));
}
