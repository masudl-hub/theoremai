import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';

registerFixtureProviders(defaultKernelScope);

import { assertEquals } from '@std/assert';
import { registerProfile, registerTraceDestination } from '../../mod.ts';
import { createStudioHandler, type StudioDescription } from '../../studio/server/handler.ts';
import { MockLiveWebSocket } from '../fixtures/live-socket.ts';

const HOST = '127.0.0.1:4983';
const BASE = `http://${HOST}/api/studio`;

registerProfile({
  type: 'live',
  id: 'quiet-line',
  identity: { handle: 'Quiet' },
  models: { main: { provider: 'google', apiId: 'gemini-3.8-live', keySlot: 'identity' } },
  tools: { allow: [] },
  live: { voice: 'Aoede', ingress: { text: true, audio: false, video: false } },
});
/** What the profile's own trace store was written. */
const stored: unknown[] = [];
registerTraceDestination('garden-store', {
  write: (record) => {
    stored.push(record);
    return Promise.resolve();
  },
});
registerProfile({
  type: 'live',
  id: 'garden-line',
  observability: { writeTo: 'garden-store' },
  identity: { handle: 'Line' },
  models: { main: { provider: 'google', apiId: 'gemini-3.8-live', keySlot: 'identity' } },
  tools: { allow: [] },
  live: { voice: 'Aoede', ingress: { text: true, audio: false, video: false } },
});

/** The handler for one call: the page's socket as the server holds it, and the model's. */
function served(upgrade = true) {
  const page = new MockLiveWebSocket();
  const model = new MockLiveWebSocket();
  const handler = createStudioHandler({
    project: 'garden',
    pageOrigins: [],
    listenHost: HOST,
    provider: {
      vault: { identity: 'fixture-key' },
      openWebSocket: () => {
        setTimeout(() => model.open(), 0);
        return Promise.resolve(model as unknown as WebSocket);
      },
    },
    ...(upgrade
      ? {
          upgrade: () => {
            page.open();
            return {
              socket: page as unknown as WebSocket,
              response: new Response(null, { status: 200 }),
            };
          },
        }
      : {}),
  });
  const ask = (path: string, headers: Record<string, string> = {}) =>
    handler(new Request(`${BASE}${path}`, { headers: { host: HOST, ...headers } }));
  return { page, model, ask };
}

/** Waits until the server has sent the page a message of this type. */
async function sent(page: MockLiveWebSocket, type: string): Promise<Record<string, unknown>> {
  for (let tries = 0; tries < 200; tries++) {
    const found = page.sent.map((row) => JSON.parse(row)).find((row) => row.type === type);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`The page was not sent '${type}': ${page.sent.join(' ')}`);
}

Deno.test('a live profile in a project is one the studio runs', async () => {
  const { ask } = served();
  const description: StudioDescription = await (await ask('')).json();
  assertEquals(description.problems, []);
  // A page that does not ask for a socket is told to.
  assertEquals((await ask('/profiles/garden-line')).status, 426);
});

Deno.test("a call opens the project's own session and ends it when the page leaves", async () => {
  const { page, model, ask } = served();
  await ask('/profiles/garden-line', { upgrade: 'websocket' });
  page.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'open' }) }));
  await sent(page, 'ready');
  assertEquals(
    model.sent.some((row) => row.includes('"setup"')),
    true,
  );
  page.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(model.readyState, 3);
});

/** Opens a call, ends it, and gives what the page was sent. */
async function called(profileId: string): Promise<Record<string, unknown>[]> {
  const { page, ask } = served();
  await ask(`/profiles/${profileId}`, { upgrade: 'websocket' });
  page.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'open' }) }));
  await sent(page, 'ready');
  // The server's end hears the page leave; the mock's own close would stop what it records.
  page.dispatchEvent(new CloseEvent('close'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return page.sent.map((row) => JSON.parse(row));
}

Deno.test("a call's trace reaches the page when the profile records one", async () => {
  const { page, model, ask } = served();
  await ask('/profiles/garden-line', { upgrade: 'websocket' });
  page.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'open' }) }));
  await sent(page, 'ready');
  // The model answers, and the response's record is written as it completes.
  const answer = {
    serverContent: { modelTurn: { parts: [{ text: 'Water the fern.' }] }, turnComplete: true },
  };
  page.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({ type: 'text', text: 'What needs water?' }),
    }),
  );
  model.deliver(answer);
  const line = await sent(page, 'trace');
  assertEquals(JSON.stringify(line.record).includes('garden-line'), true);
  // A call made in the studio is a test: the profile's own store is not written.
  assertEquals(stored, []);
  page.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

Deno.test('a profile that records nothing sends the page no trace', async () => {
  assertEquals(
    (await called('quiet-line')).some((row) => row.type === 'trace'),
    false,
  );
});

Deno.test('a call that cannot open tells the page why and closes', async () => {
  const { page, ask } = served();
  await ask('/profiles/garden-line', { upgrade: 'websocket' });
  page.dispatchEvent(new MessageEvent('message', { data: 'not an open message' }));
  const error = await sent(page, 'error');
  assertEquals(error.errorKind, 'request');
  assertEquals(page.readyState, 3);
});

Deno.test('a server that takes no socket names the live profile it cannot run', async () => {
  const { ask } = served(false);
  const description: StudioDescription = await (await ask('')).json();
  assertEquals(description.problems.map((problem) => problem.profile).toSorted(), [
    'garden-line',
    'quiet-line',
  ]);
});
