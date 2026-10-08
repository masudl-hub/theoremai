import { assertEquals } from '@std/assert';
import registerExample from '../../studio/example.ts';
import { createStudioHandler, type StudioDescription } from '../../studio/handler.ts';

registerExample();

const LISTEN = '127.0.0.1:4983';
const PAGE = 'http://localhost:5174';
const handler = createStudioHandler({
  project: 'garden',
  pageOrigins: [PAGE],
  listenHost: LISTEN,
});

function request(path: string, init: RequestInit & { host?: string; origin?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set('host', init.host ?? LISTEN);
  if (init.origin) headers.set('origin', init.origin);
  return new Request(`http://${LISTEN}${path}`, { ...init, headers });
}

async function call(name: string, input: unknown): Promise<Array<Record<string, unknown>>> {
  const response = await handler(
    request('/api/studio/profiles/garden-desk/call', {
      method: 'POST',
      origin: PAGE,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, input }),
    }),
  );
  assertEquals(response.status, 200);
  return (await response.text())
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

Deno.test('the project opens as a workspace: an agent per profile, and every registered tool in the library', async () => {
  const response = await handler(request('/api/studio'));
  assertEquals(response.status, 200);
  const studio: StudioDescription = await response.json();
  assertEquals(studio.project, 'garden');
  assertEquals(studio.problems, []);
  const { agents, toolSpecs } = studio.workspace;
  assertEquals(
    agents.map((agent) => [agent.identity.agentId, agent.identity.profileType]),
    [['garden-desk', 'host']],
  );
  const named = (key: string) => toolSpecs.find((tool) => tool.key === key)?.toolName;
  assertEquals(agents[0]?.tools.allow.map(named), ['list_plants', 'log_watering']);
  // A tool no profile allows is still the project's.
  const removal = toolSpecs.find((tool) => tool.toolName === 'remove_plant');
  assertEquals(removal?.access, 'destructive');
});

Deno.test("a tool keeps the project's own schema, with its choices and notes", async () => {
  const studio: StudioDescription = await (await handler(request('/api/studio'))).json();
  const list = studio.workspace.toolSpecs.find((tool) => tool.toolName === 'list_plants');
  assertEquals(JSON.parse(list?.inputJson ?? '{}').properties.light, {
    description: 'Only plants that want this light.',
    type: 'string',
    enum: ['sun', 'shade'],
  });
});

Deno.test('a profile runs only the tools it allows', async () => {
  const response = await handler(request('/api/studio/profiles/garden-desk'));
  const { interface: host } = await response.json();
  assertEquals(
    host.tools.map((tool: { name: string }) => tool.name),
    ['list_plants', 'log_watering'],
  );
  assertEquals((await handler(request('/api/studio/profiles/nobody'))).status, 404);
});

Deno.test('a read-only tool runs and returns its output', async () => {
  const events = await call('list_plants', { light: 'shade' });
  const complete = events.find(
    (event) => (event.tool as { phase?: string } | undefined)?.phase === 'complete',
  );
  assertEquals((complete?.tool as { output: unknown } | undefined)?.output, {
    plants: [{ id: 'fern', name: 'Boston fern', waterEveryDays: 3, light: 'shade' }],
  });
});

Deno.test('a tool that writes stops to ask before it runs', async () => {
  const events = await call('log_watering', { plantId: 'fern', millilitres: 200 });
  const gated = events.find((event) => event.type === 'stage' && event.gate !== undefined);
  assertEquals((gated?.gate as { kind: string } | undefined)?.kind, 'permission');
  assertEquals(
    events.some((event) => (event.tool as { phase?: string } | undefined)?.phase === 'complete'),
    false,
  );
});

Deno.test('a request from another site, or to another host name, is refused', async () => {
  assertEquals(
    (await handler(request('/api/studio', { origin: 'https://other.example' }))).status,
    403,
  );
  assertEquals((await handler(request('/api/studio', { host: 'other.example' }))).status, 403);
  assertEquals((await handler(request('/api/studio', { origin: PAGE }))).status, 200);
});

Deno.test('a path the studio does not serve is not found', async () => {
  assertEquals((await handler(request('/api/other'))).status, 404);
});
