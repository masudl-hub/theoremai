import { assertEquals } from '../../../src/kernel/engine/assert.ts';
import type { ProviderCompleteRequest } from '../../../src/kernel/types.ts';
import { createLocalProvider } from '../../../src/providers/local/local.ts';
import { bearerFetch } from '../../../src/providers/shared/vault.ts';

const vault = { main: 'main-key', spare: 'spare-key' };

function recordingFetch(status: (auth: string) => number): {
  seen: string[];
  send: typeof fetch;
} {
  const seen: string[] = [];
  const send = ((_url: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('Authorization') ?? '';
    seen.push(auth);
    return Promise.resolve(new Response('{}', { status: status(auth) }));
  }) as typeof fetch;
  return { seen, send };
}

const init = { headers: { Authorization: 'Bearer main-key' } };

Deno.test('a quota refusal retries once on the fallback slot, and each try is taped with its slot', async () => {
  const taped: unknown[] = [];
  const { seen, send } = recordingFetch((auth) => (auth.endsWith('main-key') ? 429 : 200));
  const req = {
    keySlot: 'main',
    fallbackKeySlot: 'spare',
    tapUpstream: (row: Record<string, unknown>) => {
      if (row.eventType === 'http_request') taped.push(row.keySlot);
    },
  };
  const res = await bearerFetch(req, send, vault, 'main-key')('https://x.test', init);
  assertEquals(res.status, 200);
  assertEquals(seen, ['Bearer main-key', 'Bearer spare-key']);
  assertEquals(taped, ['main', 'spare']);
});

Deno.test('no fallback named, or the same key there, means the refusal stands', async () => {
  for (const [req, keys] of [
    [{ keySlot: 'main' }, vault],
    [
      { keySlot: 'main', fallbackKeySlot: 'spare' },
      { main: 'main-key', spare: 'main-key' },
    ],
    [{ keySlot: 'main', fallbackKeySlot: 'absent' }, vault],
  ] as const) {
    const { seen, send } = recordingFetch(() => 429);
    const res = await bearerFetch(req, send, keys, 'main-key')('https://x.test', init);
    assertEquals(res.status, 429);
    assertEquals(seen.length, 1);
  }
});

Deno.test('a local model sends no key unless it names a slot, then the slot key as a bearer', async () => {
  const auths: (string | null)[] = [];
  const provider = createLocalProvider({
    baseUrl: 'http://local.test',
    vault,
    fetch: (_url, init) => {
      auths.push(new Headers(init?.headers).get('Authorization'));
      return Promise.resolve(new Response('nope', { status: 500 }));
    },
  });
  const req = {
    apiId: 'llama3.2',
    input: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
  } as unknown as ProviderCompleteRequest;
  await Array.fromAsync(provider.complete(req));
  await Array.fromAsync(provider.complete({ ...req, keySlot: 'main' }));
  assertEquals(auths, [null, 'Bearer main-key']);
});
