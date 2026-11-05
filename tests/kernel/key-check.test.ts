import { assertEquals } from '@std/assert';
import {
  checkKey,
  createProviderRegistry,
  geminiProvider,
  localProvider,
  openRouterProvider,
} from '../../mod.ts';

/** Answers every request with `status` and keeps what it was sent. */
function answering(status: number, body = '{}') {
  const sent: Request[] = [];
  const fetch = (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Request(url, init));
    return Promise.resolve(new Response(body, { status }));
  };
  return { sent, fetch: fetch as typeof globalThis.fetch };
}

const openRouter = () => createProviderRegistry().register(openRouterProvider, { keySlot: 'or' });

Deno.test("a key the provider takes is accepted, asked with the provider's own check and sign-in", async () => {
  const { sent, fetch } = answering(200);
  const check = await checkKey(openRouter(), { vault: { or: 'sk-or-good' }, fetch });
  assertEquals(check, { provider: 'openrouter', slot: 'or', state: 'accepted', status: 200 });
  assertEquals(sent[0]?.url, 'https://openrouter.ai/api/v1/key');
  assertEquals(sent[0]?.headers.get('authorization'), 'Bearer sk-or-good');
});

Deno.test('a refusal says what the provider said, without the key', async () => {
  const { fetch } = answering(400, '{"error":{"message":"API key sk-or-bad not valid."}}');
  const check = await checkKey(openRouter(), { key: 'sk-or-bad', fetch });
  assertEquals(check.state, 'refused');
  assertEquals(check.status, 400);
  assertEquals(check.said, 'API key … not valid.');
});

Deno.test('a server error or no answer is unreachable, not a refusal', async () => {
  assertEquals(
    (await checkKey(openRouter(), { key: 'k', ...answering(503) })).state,
    'unreachable',
  );
  const down = (() => Promise.reject(new TypeError('offline'))) as typeof fetch;
  assertEquals((await checkKey(openRouter(), { key: 'k', fetch: down })).state, 'unreachable');
});

Deno.test('a refusal that says nothing has no said', async () => {
  const check = await checkKey(openRouter(), { key: 'k', ...answering(401) });
  assertEquals(check, { provider: 'openrouter', slot: 'or', state: 'refused', status: 401 });
});

Deno.test('an empty slot is empty, and a resolver is read the way a call reads it', async () => {
  const { sent, fetch } = answering(200);
  assertEquals((await checkKey(openRouter(), { vault: { or: '  ' }, fetch })).state, 'empty');
  assertEquals((await checkKey(openRouter(), { vault: {}, fetch })).state, 'empty');
  assertEquals(sent.length, 0);
  const asked: unknown[] = [];
  const vault = {
    or: (context: unknown) => {
      asked.push(context);
      return 'sk-or-late';
    },
  };
  assertEquals((await checkKey(openRouter(), { vault, fetch })).state, 'accepted');
  assertEquals((asked[0] as { apiId?: string }).apiId, undefined);
});

Deno.test('a provider with no check is unchecked, and Gemini asks on its own host', async () => {
  const local = createProviderRegistry().register(localProvider, {
    connection: { baseUrl: 'http://127.0.0.1:11434/v1' },
    keySlot: 'local',
  });
  const { sent, fetch } = answering(200);
  assertEquals((await checkKey(local, { key: 'k', fetch })).state, 'unchecked');
  const gemini = createProviderRegistry().register(geminiProvider, { keySlot: 'g' });
  await checkKey(gemini, { key: 'AIza-good', fetch });
  assertEquals(sent[0]?.url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1');
  assertEquals(sent[0]?.headers.get('x-goog-api-key'), 'AIza-good');
});

Deno.test("a slot a model names is read in place of the provider's", async () => {
  const { sent, fetch } = answering(200);
  const check = await checkKey(openRouter(), { vault: { own: 'sk-or-own' }, slot: 'own', fetch });
  assertEquals([check.slot, check.state], ['own', 'accepted']);
  assertEquals(sent[0]?.headers.get('authorization'), 'Bearer sk-or-own');
});
