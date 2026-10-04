import { assertEquals } from '../../../src/kernel/engine/assert.ts';
import { openRouterFetch } from '../../../src/providers/openrouter/transport.ts';

Deno.test('openRouterFetch backs off on the primary key before the fallback slot, taping every try', async () => {
  const seen: string[] = [];
  const taped: unknown[] = [];
  const waits: number[] = [];
  const send = openRouterFetch(
    {
      keySlot: 'main',
      fallbackKeySlot: 'spare',
      tapUpstream: (row) => {
        if (row.eventType === 'http_request') taped.push(row.keySlot);
      },
    },
    {
      vault: { main: 'main-key', spare: 'spare-key' },
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      fetch: (_url, init) => {
        const auth = new Headers(init?.headers).get('Authorization') ?? '';
        seen.push(auth);
        return Promise.resolve(
          new Response('{}', { status: auth.endsWith('main-key') ? 429 : 200 }),
        );
      },
    },
    'main-key',
  );
  const res = await send('https://x.test', { headers: { Authorization: 'Bearer main-key' } });
  assertEquals(res.status, 200);
  assertEquals(seen, ['Bearer main-key', 'Bearer main-key', 'Bearer main-key', 'Bearer spare-key']);
  assertEquals(taped, ['main', 'main', 'main', 'spare']);
  assertEquals(waits, [1000, 2000]);
});
