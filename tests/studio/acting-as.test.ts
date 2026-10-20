import { assert, assertEquals } from '@std/assert';
import { z } from 'zod';
import { defineProfile, registerProfile, registerTool, type TurnEvent } from '../../mod.ts';
import { createHostTransport } from '../../react/src/client/host-transport.ts';
import type { TurnEventSink } from '../../react/src/client/transport.ts';
import { issuedOperationId } from '../../react/src/client/turn-client.ts';
import { newConversationKey } from '../../studio/conversation-key.ts';
import {
  ACTING_AS_HEADER,
  actingAsHeader,
  actingAsHeaders,
  actingAsSession,
  NO_ONE_SESSION,
  peopleFault,
  readPerson,
  type StudioActingAs,
  type StudioPeople,
} from '../../studio/people.ts';
import { createStudioHandler, type StudioDescription } from '../../studio/server/handler.ts';
import { chatKeyOf, freshPerson, listPeople } from '../../studio/ui/lib/acting-as.ts';
import { projectSession } from '../../studio/ui/lib/studio-project.ts';
import { toolEventsOf } from '../fixtures/events.ts';

const HOST = '127.0.0.1:4983';
const BASE = `http://${HOST}/api/studio`;

/** Who the setup's host says a run acts for. */
function whoOf(host: unknown): string | undefined {
  if (typeof host !== 'object' || host === null || !('who' in host)) return undefined;
  return typeof host.who === 'string' ? host.who : undefined;
}

registerTool({
  type: 'function',
  name: 'acting_whoami',
  description: 'Says who the run acts for.',
  category: 'test',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
  input: z.object({}),
  output: z.object({ who: z.string() }),
  handler: (_input, ctx) => {
    return { who: whoOf(ctx.host) ?? 'no one' };
  },
});
registerTool({
  type: 'function',
  name: 'acting_write',
  description: 'Writes for the person the run acts for.',
  category: 'test',
  access: 'read-write',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'always_confirm',
  input: z.object({}),
  output: z.object({ done: z.boolean() }),
  handler: () => ({ done: true }),
});
registerProfile(
  defineProfile({
    type: 'host',
    id: 'acting-desk',
    tools: { allow: ['acting_whoami', 'acting_write'] },
  }),
);

const IVY: StudioActingAs = { place: 'stage', person: { id: 'p-ivy', label: 'Ivy (test)' } };
const ROWAN: StudioActingAs = { place: 'stage', person: { id: 'p-rowan', label: 'Rowan (test)' } };
const made: string[] = [];

const PEOPLE: StudioPeople = {
  places: [
    { id: 'machine', label: 'This machine' },
    { id: 'stage', label: 'Stage' },
  ],
  existing: (place) => (place === 'stage' ? [IVY.person, ROWAN.person] : []),
  fresh: (place) => {
    made.push(place);
    return { id: `p-new-${made.length}`, label: `New person ${made.length}` };
  },
  start: IVY,
};

function studio(people: StudioPeople | undefined) {
  return createStudioHandler({
    conversationKey: newConversationKey(),
    project: 'acting',
    pageOrigins: [],
    listenHost: HOST,
    host: (_request, actingAs) =>
      actingAs ? { who: `${actingAs.place}/${actingAs.person.id}` } : undefined,
    ...(people ? { people } : {}),
  });
}

const handler = studio(PEOPLE);

/** The studio's page acting as `actingAs`: keeps the session cookie the handler issues. */
function page(actingAs: StudioActingAs | undefined, on = handler) {
  let cookie = '';
  return createHostTransport({
    endpoint: `${BASE}/profiles/acting-desk`,
    headers: () => actingAsHeaders(actingAs),
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('host', HOST);
      if (cookie) headers.set('cookie', cookie);
      const response = await on(new Request(url, { ...init, headers }));
      const issued = response.headers.get('set-cookie');
      if (issued) cookie = issued.split(';')[0] ?? '';
      return response;
    },
  });
}

async function collect(run: (onEvent: TurnEventSink) => Promise<void>): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  await run((event) => {
    if (event.type === 'unsupported' || event.type === 'malformed')
      throw new Error('A line the page cannot read.');
    events.push(event);
  });
  return events;
}

async function described(on = handler): Promise<StudioDescription> {
  return (await on(new Request(BASE, { headers: { host: HOST } }))).json();
}

Deno.test('the page is told the places, what it can ask for, and who the studio opens as', async () => {
  const { people, peopleProblem } = await described();
  assertEquals(people, {
    places: [
      { id: 'machine', label: 'This machine' },
      { id: 'stage', label: 'Stage' },
    ],
    existing: true,
    fresh: true,
    start: IVY,
  });
  assertEquals(peopleProblem, undefined);
});

Deno.test('a setup that offers no people runs every tool as no one', async () => {
  const bare = studio(undefined);
  assertEquals((await described(bare)).people, undefined);
  const events = await collect((onEvent) =>
    page(undefined, bare).call({ name: 'acting_whoami', input: {} }, onEvent),
  );
  assertEquals(toolEventsOf(events, 'complete')[0]?.output, { who: 'no one' });
});

Deno.test('a run carries the pick to the setup, and with no pick it acts as no one', async () => {
  const asIvy = await collect((onEvent) =>
    page(IVY).call({ name: 'acting_whoami', input: {} }, onEvent),
  );
  assertEquals(toolEventsOf(asIvy, 'complete')[0]?.output, { who: 'stage/p-ivy' });
  const asNoOne = await collect((onEvent) =>
    page(undefined).call({ name: 'acting_whoami', input: {} }, onEvent),
  );
  assertEquals(toolEventsOf(asNoOne, 'complete')[0]?.output, { who: 'no one' });
});

Deno.test("one person cannot answer another person's held call", async () => {
  const ivy = page(IVY);
  const paused = await collect((onEvent) => ivy.call({ name: 'acting_write', input: {} }, onEvent));
  const gate = toolEventsOf(paused, 'gate').at(-1);
  assert(gate, 'the write ran unasked');
  const answer: Parameters<typeof ivy.invoke>[0] = {
    gateId: gate.callId,
    operationId: issuedOperationId(gate),
    decision: 'approve',
  };
  const fromRowan = await collect((onEvent) => page(ROWAN).invoke(answer, onEvent)).catch(
    (error: unknown) => error,
  );
  assert(
    !Array.isArray(fromRowan) || toolEventsOf(fromRowan, 'complete').length === 0,
    "Rowan's answer ran Ivy's call",
  );
  const fromIvy = await collect((onEvent) => ivy.invoke(answer, onEvent));
  assertEquals(toolEventsOf(fromIvy, 'complete')[0]?.output, { done: true });
});

Deno.test('each person has a session of their own, and a new label keeps it', () => {
  assertEquals(actingAsSession(undefined), NO_ONE_SESSION);
  assert(actingAsSession(IVY) !== actingAsSession(ROWAN));
  assertEquals(
    actingAsSession(IVY),
    actingAsSession({ ...IVY, person: { ...IVY.person, label: 'Ivy' } }),
  );
  assert(actingAsSession(IVY) !== actingAsSession({ ...IVY, place: 'machine' }));
});

Deno.test('a run in a place the setup does not offer, or a pick it cannot read, is refused', async () => {
  const run = (value: string) =>
    handler(
      new Request(`${BASE}/profiles/acting-desk/call`, {
        method: 'POST',
        headers: { host: HOST, 'content-type': 'application/json', [ACTING_AS_HEADER]: value },
        body: JSON.stringify({ name: 'acting_whoami', input: {} }),
      }),
    );
  const elsewhere = await run(actingAsHeader({ ...IVY, place: 'production' }));
  assertEquals(elsewhere.status, 400);
  assertEquals((await elsewhere.json()).message, "The setup file offers no place 'production'.");
  assertEquals((await run('not a pick')).status, 400);
});

Deno.test('the page asks the setup for the people in a place, and for a fresh one', async () => {
  const listed = await handler(
    new Request(`${BASE}/people?place=stage`, { headers: { host: HOST } }),
  );
  assertEquals(await listed.json(), { people: [IVY.person, ROWAN.person] });
  const fresh = await handler(
    new Request(`${BASE}/people/fresh`, {
      method: 'POST',
      headers: { host: HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ place: 'machine' }),
    }),
  );
  assertEquals(await fresh.json(), { person: { id: 'p-new-1', label: 'New person 1' } });
  assertEquals(made, ['machine']);
  const nowhere = await handler(
    new Request(`${BASE}/people?place=moon`, { headers: { host: HOST } }),
  );
  assertEquals(nowhere.status, 400);
});

Deno.test('what the setup says when it cannot find or make a person reaches the page as it said it', async () => {
  const failing = studio({
    places: [{ id: 'stage', label: 'Stage' }],
    existing: () => {
      throw new Error('Stage is not reachable.');
    },
  });
  const listed = await failing(
    new Request(`${BASE}/people?place=stage`, { headers: { host: HOST } }),
  );
  assertEquals([listed.status, (await listed.json()).message], [502, 'Stage is not reachable.']);
  // A setup that is not type-checked can answer a person with no label: the page never shows it.
  const unlabelled: unknown = { id: 'p-1' };
  let refused = '';
  try {
    readPerson(unlabelled, 'fresh');
  } catch (error) {
    refused = error instanceof Error ? error.message : '';
  }
  assertEquals(refused, "The setup file's fresh answered a person without an id and a label.");
});

Deno.test('people the setup file exports wrong are not offered, and the page is told why', async () => {
  assertEquals(
    peopleFault({ places: [] }),
    'The people the setup file exports need places: a list of { id, label }, at least one.',
  );
  assertEquals(
    peopleFault({
      places: [
        { id: 'a', label: 'A' },
        { id: 'a', label: 'B' },
      ],
    }),
    'The places the setup file exports share an id.',
  );
  assertEquals(
    peopleFault({ places: [{ id: 'a', label: 'A' }], fresh: 'yes' }),
    "The people the setup file exports have a 'fresh' that is not a function.",
  );
  assertEquals(
    peopleFault({
      places: [{ id: 'a', label: 'A' }],
      start: { place: 'b', person: { id: 'x', label: 'X' } },
    }),
    "The setup file starts in a place it does not offer: 'b'.",
  );
  const wrong = studio({ places: [] });
  const { people, peopleProblem } = await described(wrong);
  assertEquals(people, undefined);
  assert(peopleProblem);
});

Deno.test("the page keeps each person's chat apart from no one's, and reads what the setup answers", async () => {
  assertEquals(chatKeyOf('desk', undefined), 'desk');
  assert(chatKeyOf('desk', IVY) !== chatKeyOf('desk', ROWAN));
  assert(chatKeyOf('desk', IVY) !== chatKeyOf('desk', undefined));
  const project = { ...projectSession('acting'), endpoint: BASE };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('host', HOST);
    return handler(new Request(input, { ...init, headers }));
  };
  try {
    assertEquals(await listPeople(project, 'stage'), [IVY.person, ROWAN.person]);
    assertEquals((await freshPerson(project, 'stage')).label.startsWith('New person'), true);
    const refused = await listPeople(project, 'moon').catch((error: unknown) =>
      error instanceof Error ? error.message : '',
    );
    assertEquals(refused, "The setup file offers no place 'moon'.");
  } finally {
    globalThis.fetch = realFetch;
  }
});
