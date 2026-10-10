/**
 * Where the nodes someone dragged on the map were put, kept in this tab's sessionStorage beside the
 * workspace: a project's under its own name.
 */
import type { MapPlace } from '../../mod.ts';
import { isRecord, session, WORKSPACE_KEY } from './studio-session.ts';

export type MapPlaces = Readonly<Record<string, MapPlace>>;

const placesKey = (project: string | undefined) =>
	project === undefined ? `${WORKSPACE_KEY}.map` : `${WORKSPACE_KEY}.map.project:${project}`;

/** The kept places; none when nothing was kept or what was kept cannot be read. */
export function readMapPlaces(project: string | undefined): MapPlaces {
	try {
		const kept: unknown = JSON.parse(session()?.getItem(placesKey(project)) ?? 'null');
		if (!isRecord(kept)) return {};
		const places: Record<string, MapPlace> = {};
		for (const [id, place] of Object.entries(kept)) {
			if (isRecord(place) && typeof place.x === 'number' && typeof place.y === 'number') {
				places[id] = { x: place.x, y: place.y };
			}
		}
		return places;
	} catch {
		return {};
	}
}

/** Keeps `places`, or forgets them all when there are none. Storage that is full or blocked keeps nothing. */
export function writeMapPlaces(project: string | undefined, places: MapPlaces): void {
	try {
		if (Object.keys(places).length === 0) session()?.removeItem(placesKey(project));
		else session()?.setItem(placesKey(project), JSON.stringify(places));
	} catch {
		// Nothing to do: the places last until the page goes.
	}
}
