import { assertEquals } from '@std/assert';
import registerExample from '../../studio/example.ts';
import { createStudioHandler, type StudioDescription } from '../../studio/handler.ts';

registerExample();

const LISTEN = '127.0.0.1:4983';
const PAGE = 'http://127.0.0.1:4984';
const handler = createStudioHandler({ project: 'garden', pageOrigin: PAGE, listenHost: LISTEN });

function request(path: string, init: RequestInit & { host?: string; origin?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set('host', init.host ?? LISTEN);
  if (init.origin) headers.set('origin', init.origin);
  return new Request(`http://${LISTEN}${path}`, { ...init, headers });
}

async function call(name: string, input: unknown): Promise<Array<Record<string, unknown>>> {
  const response = await handler(
    request('/api/studio/host/call', {
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

Deno.test('the tree lists the project: each profile with its tools, each tool with who allows it', async () => {
  const response = await handler(request('/api/studio'));
  assertEquals(response.status, 200);
  const studio: StudioDescription = await response.json();
  assertEquals(studio.project, 'garden');
  const desk = studio.profiles.find((profile) => profile.id === 'garden-desk');
  assertEquals(desk?.tools, ['list_plants', 'log_watering']);
  const byName = new Map(studio.tools.map((tool) => [tool.name, tool]));
  assertEquals(byName.get('list_plants')?.usedBy, ['garden-desk']);
  assertEquals(byName.get('remove_plant')?.usedBy, []);
  assertEquals(byName.get('remove_plant')?.access, 'destructive');
  // The profile the studio serves tools through is not the project's.
  assertEquals(
    studio.profiles.some((profile) => profile.id === 'theorem-studio'),
    false,
  );
});

Deno.test('a tool no profile allows is still callable from the console', async () => {
  const response = await handler(request('/api/studio/host'));
  const { interface: host } = await response.json();
  assertEquals(
    host.tools.map((tool: { name: string }) => tool.name).includes('remove_plant'),
    true,
  );
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
