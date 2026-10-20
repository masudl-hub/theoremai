/**
 * Who the project's runs act as: the builder's pick of a person in a place, from the people the
 * setup file offers. Settings is where it is picked; every run carries it to the project, and each
 * person keeps a chat of their own. The pick is kept in this tab, beside the chats it keys.
 */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import {
  actingAsSession,
  readPerson,
  readPick,
  type StudioActingAs,
  type StudioPeopleOffer,
  type StudioPerson,
} from '../../people.ts';
import type { ProjectSession } from './studio-project.ts';
import { isRecord, session, WORKSPACE_KEY } from './studio-session.ts';

export interface ActingAsState {
  /** What the setup file offers; none when it offers no people. */
  offer: StudioPeopleOffer | undefined;
  /** Why the people the setup file exports cannot be offered. */
  problem: string | undefined;
  /** Who runs act as now; none is no one. */
  actingAs: StudioActingAs | undefined;
  choose: (next: StudioActingAs | undefined) => void;
}

const NO_PEOPLE: ActingAsState = {
  offer: undefined,
  problem: undefined,
  actingAs: undefined,
  choose: () => undefined,
};

/** Set by the studio while a project is open. Without it, every run acts as no one. */
export const ActingAsContext = createContext<ActingAsState>(NO_PEOPLE);

export function useActingAs(): ActingAsState {
  return useContext(ActingAsContext);
}

const pickKey = (project: string) => `${WORKSPACE_KEY}.acting-as:${project}`;

/** The builder's last pick in this tab: `null` for no one, nothing when they never picked. */
function keptPick(project: string): { value: unknown } | undefined {
  try {
    const raw = session()?.getItem(pickKey(project));
    return raw ? { value: JSON.parse(raw) } : undefined;
  } catch {
    return undefined;
  }
}

function keepPick(project: string, pick: StudioActingAs | null): void {
  try {
    session()?.setItem(pickKey(project), JSON.stringify(pick));
  } catch {
    // Storage refused: the pick lasts as long as the page.
  }
}

/**
 * The pick for a project: the builder's last one in this tab, else the one the setup file starts
 * on, else no one. A pick in a place the setup no longer offers is no one.
 */
export function useActingAsState(project: ProjectSession | null): ActingAsState {
  const name = project?.name;
  const offer = project?.people;
  const problem = project?.peopleProblem;
  const [chosen, setChosen] = useState(() => (name ? keptPick(name) : undefined));
  const actingAs = useMemo(() => {
    if (!offer) return undefined;
    const value = chosen ? chosen.value : offer.start;
    if (value === null || value === undefined) return undefined;
    const read = readPick(value, offer.places);
    return read.ok ? read.actingAs : undefined;
  }, [offer, chosen]);
  const choose = useCallback(
    (next: StudioActingAs | undefined) => {
      setChosen({ value: next ?? null });
      if (name) keepPick(name, next ?? null);
    },
    [name],
  );
  return useMemo(
    () => (offer || problem ? { offer, problem, actingAs, choose } : NO_PEOPLE),
    [offer, problem, actingAs, choose],
  );
}

/** Where an agent's chat is kept for a pick: no one's is the agent's own, each person's beside it. */
export function chatKeyOf(chatWith: string, actingAs: StudioActingAs | undefined): string {
  return actingAs ? `${chatWith}@${actingAsSession(actingAs)}` : chatWith;
}

/** What the studio server answered, or what it said went wrong. */
async function answered(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok) return body;
  const said = isRecord(body) && typeof body.message === 'string' ? body.message : undefined;
  throw new Error(said ?? `The studio server answered ${String(response.status)}.`);
}

/** The people already in `place` that the setup file offers. */
export async function listPeople(project: ProjectSession, place: string): Promise<StudioPerson[]> {
  const body = await answered(
    await fetch(`${project.endpoint}/people?place=${encodeURIComponent(place)}`),
  );
  const people: unknown[] = isRecord(body) && Array.isArray(body.people) ? body.people : [];
  return people.map((person) => readPerson(person, 'existing'));
}

/** A new person the setup file makes in `place`. */
export async function freshPerson(project: ProjectSession, place: string): Promise<StudioPerson> {
  const body = await answered(
    await fetch(`${project.endpoint}/people/fresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ place }),
    }),
  );
  return readPerson(isRecord(body) ? body.person : undefined, 'fresh');
}
