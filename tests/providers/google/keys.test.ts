import '../../fixtures/test-host.ts';
import { TheoremError } from '../../../src/guardrails/error.ts';
import { getProfile, registerProfile, resolveTurn } from '../../../src/kernel/default-scope.ts';
import { assertEquals } from '../../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../../src/kernel/registry/profiles.ts';
import { requireModelProfile } from '../../../src/kernel/registry/resolve.ts';
import type { KeyVault } from '../../../src/kernel/types.ts';
import { fetchGemini, withApiKey } from '../../../src/providers/google/keys.ts';
import { fallbackKey, requireKey } from '../../../src/providers/shared/vault.ts';

const vault: KeyVault = {
  slot_a: 'free-a-key',
  slot_b: 'free-b-key',
  slot_c: 'free-c-key',
  spare: 'spare-key',
};

const HTTP_OK = 200;
const HTTP_QUOTA = 429;

function noWait(): Promise<void> {
  return Promise.resolve();
}

function headerApiKey(init?: RequestInit): string {
  return new Headers(init?.headers).get('x-goog-api-key') ?? '';
}

function responseForKey(key: string): Response {
  if (key === 'spare-key') {
    return new Response('body', { status: HTTP_OK });
  }
  return new Response('body', { status: HTTP_QUOTA });
}

function withBuiltins(
  id: string,
  baseProfile: string,
  builtInTools: string[],
  modelId?: string,
): void {
  const base = requireModelProfile(getProfile(baseProfile), 'test');
  const models = { ...base.models };
  const targetId = modelId ?? base.defaultModel ?? Object.keys(models)[0];
  for (const mid of Object.keys(models)) {
    models[mid] = {
      ...models[mid],
      builtInTools: mid === targetId ? builtInTools : [],
    };
  }
  registerProfile(
    defineProfile({
      ...base,
      id,
      models,
    } as Parameters<typeof defineProfile>[0]),
  );
}

withBuiltins('chat_search', 'chat', ['googleSearch']);
withBuiltins('formatter_search', 'formatter', ['googleSearch']);
withBuiltins('selector_fast_search', 'selector', ['googleSearch'], 'gemini35FlashLite');
withBuiltins('chat_maps', 'chat', ['googleMaps']);
withBuiltins('selector_fast_maps', 'selector', ['googleMaps'], 'gemini35FlashLite');
withBuiltins('selector_smart_maps', 'selector', ['googleMaps'], 'gemini31ProPreview');
withBuiltins('chat_url', 'chat', ['urlContext']);

Deno.test('host profiles default to their configured key slots', () => {
  assertEquals(resolveTurn({ profile: 'chat', input: { text: 'x' } }).generation.keySlot, 'slot_a');
  assertEquals(resolveTurn({ profile: 'pinned', input: {} }).generation.keySlot, 'slot_a');
  assertEquals(
    resolveTurn({ profile: 'formatter', input: { text: 'x' } }).generation.keySlot,
    'slot_c',
  );
  assertEquals(
    resolveTurn({ profile: 'selector', model: 'gemini35FlashLite', input: { text: 'x' } })
      .generation.keySlot,
    'slot_b',
  );
});

Deno.test('the image model uses the slot it pins', () => {
  assertEquals(
    resolveTurn({ profile: 'image', input: { text: 'fox' } }).generation.keySlot,
    'slot_b',
  );
});

Deno.test('pro preview without search or maps stays on the configured key slot', () => {
  const { generation } = resolveTurn({
    profile: 'selector',
    model: 'gemini31ProPreview',
    input: { text: 'x' },
  });
  assertEquals(generation.model, 'gemini31ProPreview');
  assertEquals(generation.keySlot, 'slot_b');
});

Deno.test('search stays on the profile key; no tool picks a key on its own', () => {
  assertEquals(
    resolveTurn({ profile: 'chat_search', input: { text: 'x' } }).generation.keySlot,
    'slot_a',
  );
  assertEquals(
    resolveTurn({ profile: 'formatter_search', input: { text: 'x' } }).generation.keySlot,
    'slot_c',
  );
  assertEquals(
    resolveTurn({
      profile: 'selector_fast_search',
      model: 'gemini35FlashLite',
      input: { text: 'x' },
    }).generation.keySlot,
    'slot_b',
  );
});

Deno.test('maps uses the profile key slot', () => {
  assertEquals(
    resolveTurn({ profile: 'chat_maps', input: { text: 'x' } }).generation.keySlot,
    'slot_a',
  );
  assertEquals(
    resolveTurn({
      profile: 'selector_fast_maps',
      model: 'gemini35FlashLite',
      input: { text: 'x' },
    }).generation.keySlot,
    'slot_b',
  );
  assertEquals(
    resolveTurn({
      profile: 'selector_smart_maps',
      model: 'gemini31ProPreview',
      input: { text: 'x' },
    }).generation.keySlot,
    'slot_b',
  );
});

Deno.test('url context uses the profile key slot', () => {
  assertEquals(
    resolveTurn({ profile: 'chat_url', input: { text: 'x' } }).generation.keySlot,
    'slot_a',
  );
});

Deno.test('fetchGemini never uses the fallback when the key answers', async () => {
  const used: string[] = [];
  const res = await fetchGemini(
    'https://example.com/v1',
    { method: 'POST', body: '{}' },
    'slot_b',
    {
      vault,
      wait: noWait,
      fetch: (_url, init) => {
        used.push(headerApiKey(init));
        return Promise.resolve(new Response('ok', { status: HTTP_OK }));
      },
    },
    undefined,
    'spare',
  );
  assertEquals(res.status, HTTP_OK);
  assertEquals(used, ['free-b-key']);
});

Deno.test('fetchGemini retries on the fallback slot after 429 backoff, not before', async () => {
  const used: string[] = [];
  const res = await fetchGemini(
    'https://example.com/v1?key=strip-me',
    { method: 'POST', body: '{}' },
    'slot_a',
    {
      vault,
      wait: noWait,
      fetch: (_url, init) => {
        const key = headerApiKey(init);
        used.push(key);
        return Promise.resolve(responseForKey(key));
      },
    },
    undefined,
    'spare',
  );
  assertEquals(res.status, HTTP_OK);
  assertEquals(used, ['free-a-key', 'free-a-key', 'free-a-key', 'spare-key']);
});

Deno.test('fetchGemini without a fallback slot returns the quota refusal', async () => {
  const used: string[] = [];
  const res = await fetchGemini(
    'https://example.com/v1',
    { method: 'POST', body: '{}' },
    'slot_a',
    {
      vault,
      wait: noWait,
      fetch: (_url, init) => {
        const key = headerApiKey(init);
        used.push(key);
        return Promise.resolve(responseForKey(key));
      },
    },
  );
  assertEquals(res.status, HTTP_QUOTA);
  assertEquals(used, ['free-a-key', 'free-a-key', 'free-a-key']);
});

Deno.test('a slot the vault lacks throws before any fetch', async () => {
  let threw = false;
  try {
    await fetchGemini('https://example.com/v1', {}, 'missing', {
      vault: { ...vault },
      wait: noWait,
      fetch: () => {
        throw new Error('must not fetch');
      },
    });
  } catch (err) {
    threw = err instanceof TheoremError && err.kind === 'auth';
  }
  assertEquals(threw, true);
});

Deno.test('fetchGemini retries on transient network errors before succeeding', async () => {
  let attempts = 0;
  const res = await fetchGemini('https://example.com/v1/ping', { method: 'GET' }, 'slot_a', {
    vault,
    wait: noWait,
    fetch: () => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(new Error('fetch failed: network error socket'));
      }
      return Promise.resolve(new Response('pong', { status: HTTP_OK }));
    },
  });
  assertEquals(res.status, HTTP_OK);
  assertEquals(attempts, 2);
});

Deno.test('fetchGemini tapes every try under the slot it was sent with', async () => {
  const rows: Record<string, unknown>[] = [];
  await fetchGemini(
    'https://example.com/v1?key=strip-me',
    { method: 'POST', body: '{"model":"m"}' },
    'slot_a',
    {
      vault,
      wait: noWait,
      fetch: (_url, init) => Promise.resolve(responseForKey(headerApiKey(init))),
    },
    (row) => rows.push(row),
    'spare',
  );
  const requests = rows.filter((row) => row.eventType === 'http_request');
  assertEquals(
    requests.map((row) => row.keySlot),
    ['slot_a', 'slot_a', 'slot_a', 'spare'],
  );
  assertEquals(requests[0]?.url, 'https://example.com/v1');
  assertEquals(requests[0]?.body, { model: 'm' });
  assertEquals(
    rows.filter((row) => row.eventType === 'http_response').map((row) => row.status),
    [429, 429, 429, HTTP_OK],
  );
});

Deno.test('fallbackKey offers only a named, filled, different key', () => {
  assertEquals(fallbackKey(undefined, vault, 'free-a-key'), undefined);
  assertEquals(fallbackKey('spare', { ...vault, spare: undefined }, 'free-a-key'), undefined);
  assertEquals(fallbackKey('spare', vault, 'spare-key'), undefined);
  assertEquals(fallbackKey('spare', vault, 'free-a-key'), { slot: 'spare', key: 'spare-key' });
});

Deno.test('withApiKey sets the api key header and Content-Type for non-GET requests', () => {
  const init = withApiKey({ method: 'POST' }, 'my-key');
  const headers = new Headers(init.headers);
  assertEquals(headers.get('x-goog-api-key'), 'my-key');
  assertEquals(headers.get('Content-Type'), 'application/json');
});

Deno.test('withApiKey preserves an existing Content-Type header', () => {
  const init = withApiKey({ method: 'POST', headers: { 'Content-Type': 'text/plain' } }, 'my-key');
  const headers = new Headers(init.headers);
  assertEquals(headers.get('Content-Type'), 'text/plain');
});

Deno.test('withApiKey does not set Content-Type for GET requests', () => {
  const init = withApiKey({ method: 'GET' }, 'my-key');
  const headers = new Headers(init.headers);
  assertEquals(headers.get('x-goog-api-key'), 'my-key');
  assertEquals(headers.get('Content-Type'), null);
});

Deno.test('withApiKey defaults to GET behavior when no method is given', () => {
  const init = withApiKey({}, 'my-key');
  const headers = new Headers(init.headers);
  assertEquals(headers.get('Content-Type'), null);
});

Deno.test('requireKey throws TheoremError when the slot has no key', () => {
  let threw = false;
  try {
    requireKey({ ...vault, slot_a: undefined }, 'slot_a');
  } catch (err) {
    threw = err instanceof TheoremError && err.kind === 'auth';
  }
  assertEquals(threw, true);
});

Deno.test('requireKey returns the key when present', () => {
  assertEquals(requireKey(vault, 'slot_a'), 'free-a-key');
});
