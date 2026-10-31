/**
 * Who a studio run acts as. The application names the places its data lives in and the people a
 * run may act as there; the studio shows who and where, and carries the builder's pick to the
 * application with every run. The studio knows nothing of sign-in, accounts or clean-up: making a
 * fresh person, finding existing ones, and whether a place is safe to use are the application's.
 *
 * A run with no pick acts as no one.
 *
 * @module
 */

import { z } from 'zod';

/** A place the application's data lives in, as the application names it: its own machine, stage. */
export interface StudioPlace {
  id: string;
  label: string;
}

/** A person a run may act as, as the application names them. */
export interface StudioPerson {
  id: string;
  label: string;
}

/** The builder's pick: a person in a place. No pick is no one. */
export interface StudioActingAs {
  place: string;
  person: StudioPerson;
}

/**
 * What a setup file offers as `export const people`. Every part is the application's: the studio
 * calls `existing` and `fresh` when the builder asks, and keeps nothing they return.
 */
export interface StudioPeople {
  places: readonly StudioPlace[];
  /** The people already in a place that the builder may pick. */
  existing?: (place: string) => readonly StudioPerson[] | Promise<readonly StudioPerson[]>;
  /** Makes a new person in a place. Removing them later is the application's. */
  fresh?: (place: string) => StudioPerson | Promise<StudioPerson>;
  /** Who the studio opens acting as. Without it the studio opens acting as no one. */
  start?: StudioActingAs;
}

/** What the page reads of the people a setup file offers: the places, and what it can ask for. */
export interface StudioPeopleOffer {
  places: StudioPlace[];
  existing: boolean;
  fresh: boolean;
  start?: StudioActingAs;
}

/** The header each run carries the builder's pick in. No header is no one. */
export const ACTING_AS_HEADER = 'x-theorem-studio-acting-as';
/** The pick on a live socket's address: a browser's `WebSocket` sends no headers. */
export const ACTING_AS_PARAM = 'acting-as';

/** The session a run acting as no one is in. */
export const NO_ONE_SESSION = 'theorem-studio-local';

const nameSchema = z.object({ id: z.string().min(1), label: z.string().min(1) });
const actingAsSchema = z.object({ place: z.string().min(1), person: nameSchema });
const peopleSchema = z.object({
  places: z.array(nameSchema).min(1),
  existing: z.unknown().optional(),
  fresh: z.unknown().optional(),
  start: actingAsSchema.optional(),
});

/** The pick as a header value: the label may be any text, and a header holds only some. */
export function actingAsHeader(actingAs: StudioActingAs): string {
  return encodeURIComponent(JSON.stringify(actingAs));
}

/** The headers a run sends for a pick: none for no one. */
export function actingAsHeaders(actingAs: StudioActingAs | undefined): Record<string, string> {
  return actingAs ? { [ACTING_AS_HEADER]: actingAsHeader(actingAs) } : {};
}

/**
 * The session a pick's runs share. Each person has their own, so one person's chat, held calls
 * and answers are never another's; the label is left out, so renaming a person keeps their chat.
 */
export function actingAsSession(actingAs: StudioActingAs | undefined): string {
  if (!actingAs) return NO_ONE_SESSION;
  return `${NO_ONE_SESSION}:${encodeURIComponent(actingAs.place)}:${encodeURIComponent(actingAs.person.id)}`;
}

/** What a run's pick is: no one, a person in a place the setup offers, or why it is neither. */
export type ReadActingAs =
  | { ok: true; actingAs: StudioActingAs | undefined }
  | { ok: false; message: string };

/** Reads a run's pick and checks its place is one the setup offers. */
export function readActingAs(request: Request, people: StudioPeople | undefined): ReadActingAs {
  const sent =
    request.headers.get(ACTING_AS_HEADER) ?? new URL(request.url).searchParams.get(ACTING_AS_PARAM);
  if (sent === null) return { ok: true, actingAs: undefined };
  let value: unknown;
  try {
    value = JSON.parse(decodeURIComponent(sent));
  } catch {
    return { ok: false, message: 'The person this run acts as could not be read.' };
  }
  return readPick(value, people?.places ?? []);
}

/** Reads a pick from wherever it was kept, and checks its place is one of `places`. */
export function readPick(value: unknown, places: readonly StudioPlace[]): ReadActingAs {
  const parsed = actingAsSchema.safeParse(value);
  if (!parsed.success)
    return { ok: false, message: 'The person this run acts as could not be read.' };
  const read = readPlace(parsed.data.place, places);
  return read.ok ? { ok: true, actingAs: parsed.data } : read;
}

/** `place` when it is one of `places`, or why it is not. */
export function readPlace(
  place: unknown,
  places: readonly StudioPlace[],
): { ok: true; place: string } | { ok: false; message: string } {
  if (typeof place !== 'string' || place === '')
    return { ok: false, message: 'The setup file needs a place to look in.' };
  return places.some((offered) => offered.id === place)
    ? { ok: true, place }
    : { ok: false, message: `The setup file offers no place '${place}'.` };
}

/**
 * Why the people a setup file exports cannot be offered, or nothing. A setup file is not always
 * type-checked, so the studio reads what it exports before it trusts it.
 */
export function peopleFault(people: unknown): string | undefined {
  const parsed = peopleSchema.safeParse(people);
  if (!parsed.success) {
    return 'The people the setup file exports need places: a list of { id, label }, at least one.';
  }
  const { places, existing, fresh, start } = parsed.data;
  const ids = places.map((place) => place.id);
  if (new Set(ids).size !== ids.length) return 'The places the setup file exports share an id.';
  if (existing !== undefined && typeof existing !== 'function') {
    return "The people the setup file exports have an 'existing' that is not a function.";
  }
  if (fresh !== undefined && typeof fresh !== 'function') {
    return "The people the setup file exports have a 'fresh' that is not a function.";
  }
  if (start && !ids.includes(start.place)) {
    return `The setup file starts in a place it does not offer: '${start.place}'.`;
  }
  return undefined;
}

/** What the page is told of the people a setup file offers. */
export function peopleOffer(people: StudioPeople): StudioPeopleOffer {
  return {
    places: people.places.map(({ id, label }) => ({ id, label })),
    existing: people.existing !== undefined,
    fresh: people.fresh !== undefined,
    ...(people.start ? { start: people.start } : {}),
  };
}

/** Reads what the application answered for a person, so the page never shows a malformed one. */
export function readPerson(value: unknown, from: string): StudioPerson {
  const parsed = nameSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`The setup file's ${from} answered a person without an id and a label.`);
  return parsed.data;
}
