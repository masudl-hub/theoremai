import '../../fixtures/test-host.ts';
import { TheoremError, UPSTREAM_FAILED } from '../../../src/guardrails/error.ts';
import { assertEquals } from '../../../src/kernel/engine/assert.ts';
import {
  defineProfile,
  getProfile,
  registerProfile,
} from '../../../src/kernel/registry/profiles.ts';
import { requireModelProfile, resolveTurn } from '../../../src/kernel/registry/resolve.ts';
import type { KeyVault } from '../../../src/kernel/types.ts';
import {
  backoffMs,
  canOverflow,
  fetchGemini,
  isTransientHttp,
  isTransientThrown,
  requireKey,
  waitDefault,
  withApiKey,
} from '../../../src/providers/google/keys.ts';

const vault: KeyVault = {
  slotA: 'free-a-key',
  slotB: 'free-b-key',
  slotC: 'free-c-key',
  paid: 'paid-key',
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
  if (key === 'paid-key') {
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
  assertEquals(resolveTurn({ profile: 'chat', input: { text: 'x' } }).generation.keySlot, 'slotA');
  assertEquals(resolveTurn({ profile: 'pinned', input: {} }).generation.keySlot, 'slotA');
  assertEquals(
    resolveTurn({ profile: 'formatter', input: { text: 'x' } }).generation.keySlot,
    'slotC',
  );
  assertEquals(
    resolveTurn({ profile: 'selector', model: 'gemini35FlashLite', input: { text: 'x' } })
      .generation.keySlot,
    'slotB',
  );
});

Deno.test('image model uses the paid Gemini key', () => {
  assertEquals(
    resolveTurn({ profile: 'image', input: { text: 'fox' } }).generation.keySlot,
    'paid',
  );
});

Deno.test('pro preview without search or maps stays on the configured key slot', () => {
  const { generation } = resolveTurn({
    profile: 'selector',
    model: 'gemini31ProPreview',
    input: { text: 'x' },
  });
  assertEquals(generation.model, 'gemini31ProPreview');
  assertEquals(generation.keySlot, 'slotB');
});

Deno.test('search forces the paid key when listed on the model', () => {
  assertEquals(
    resolveTurn({ profile: 'chat_search', input: { text: 'x' } }).generation.keySlot,
    'paid',
  );
  assertEquals(
    resolveTurn({ profile: 'formatter_search', input: { text: 'x' } }).generation.keySlot,
    'paid',
  );
  assertEquals(
    resolveTurn({
      profile: 'selector_fast_search',
      model: 'gemini35FlashLite',
      input: { text: 'x' },
    }).generation.keySlot,
    'paid',
  );
});

Deno.test('maps uses profile key slot unless model pins paid or builtin forces paid', () => {
  assertEquals(
    resolveTurn({ profile: 'chat_maps', input: { text: 'x' } }).generation.keySlot,
    'slotA',
  );
  assertEquals(
    resolveTurn({
      profile: 'selector_fast_maps',
      model: 'gemini35FlashLite',
      input: { text: 'x' },
    }).generation.keySlot,
    'slotB',
  );
  assertEquals(
    resolveTurn({
      profile: 'selector_smart_maps',
      model: 'gemini31ProPreview',
      input: { text: 'x' },
    }).generation.keySlot,
    'slotB',
  );
});

Deno.test('url context does not force paid', () => {
  assertEquals(
    resolveTurn({ profile: 'chat_url', input: { text: 'x' } }).generation.keySlot,
    'slotA',
  );
});

Deno.test('fetchGemini never starts on paid for a key slot that is not 429', async () => {
  const used: string[] = [];
  const res = await fetchGemini('https://example.com/v1', { method: 'POST', body: '{}' }, 'slotB', {
    vault,
    wait: noWait,
    fetch: (_url, init) => {
      used.push(headerApiKey(init));
      return Promise.resolve(new Response('ok', { status: HTTP_OK }));
    },
  });
  assertEquals(res.status, HTTP_OK);
  assertEquals(used, ['free-b-key']);
});

Deno.test('fetchGemini overflows to paid after 429 backoff, not before', async () => {
  const used: string[] = [];
  const res = await fetchGemini(
    'https://example.com/v1?key=strip-me',
    { method: 'POST', body: '{}' },
    'slotA',
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
  assertEquals(res.status, HTTP_OK);
  assertEquals(used, ['free-a-key', 'free-a-key', 'free-a-key', 'paid-key']);
});

Deno.test('missing free key throws before any fetch', async () => {
  let threw = false;
  try {
    await fetchGemini('https://example.com/v1', {}, 'slotC', {
      vault: { ...vault, slotC: undefined },
      wait: noWait,
      fetch: () => {
        throw new Error('must not fetch');
      },
    });
  } catch (err) {
    threw = err instanceof TheoremError && err.message === UPSTREAM_FAILED;
  }
  assertEquals(threw, true);
});

Deno.test('fetchGemini retries on transient network errors before succeeding', async () => {
  let attempts = 0;
  const res = await fetchGemini('https://example.com/v1/ping', { method: 'GET' }, 'slotA', {
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
    'slotA',
    {
      vault,
      wait: noWait,
      fetch: (_url, init) => Promise.resolve(responseForKey(headerApiKey(init))),
    },
    (row) => rows.push(row),
  );
  const requests = rows.filter((row) => row.eventType === 'http_request');
  assertEquals(
    requests.map((row) => row.keySlot),
    ['slotA', 'slotA', 'slotA', 'paid'],
  );
  assertEquals(requests[0]?.url, 'https://example.com/v1');
  assertEquals(requests[0]?.body, { model: 'm' });
  assertEquals(
    rows.filter((row) => row.eventType === 'http_response').map((row) => row.status),
    [429, 429, 429, HTTP_OK],
  );
});

Deno.test('isTransientHttp flags retryable status codes only', () => {
  assertEquals(isTransientHttp(408), true);
  assertEquals(isTransientHttp(429), true);
  assertEquals(isTransientHttp(500), true);
  assertEquals(isTransientHttp(502), true);
  assertEquals(isTransientHttp(503), true);
  assertEquals(isTransientHttp(504), true);
  assertEquals(isTransientHttp(200), false);
  assertEquals(isTransientHttp(400), false);
  assertEquals(isTransientHttp(401), false);
  assertEquals(isTransientHttp(403), false);
  assertEquals(isTransientHttp(404), false);
});

Deno.test('isTransientThrown matches known transient network error shapes', () => {
  assertEquals(isTransientThrown(new Error('dns lookup failed')), true);
  assertEquals(isTransientThrown(new Error('ECONNRESET')), true);
  assertEquals(isTransientThrown(new Error('fetch failed')), true);
  assertEquals(isTransientThrown(new Error('503 service unavailable')), true);
  assertEquals(isTransientThrown(new Error('socket hang up')), true);
  assertEquals(isTransientThrown(new Error('temporarily unavailable')), true);
});

Deno.test('isTransientThrown never retries abort errors', () => {
  const abort = new DOMException('The operation was aborted.', 'AbortError');
  assertEquals(isTransientThrown(abort), false);
});

Deno.test('isTransientThrown is false for unrelated errors', () => {
  assertEquals(isTransientThrown(new Error('invalid input')), false);
});

Deno.test('backoffMs follows the configured schedule and falls back after it', () => {
  assertEquals(backoffMs(0), 1000);
  assertEquals(backoffMs(1), 2000);
  assertEquals(backoffMs(2), 4000);
  assertEquals(backoffMs(3), 2000);
  assertEquals(backoffMs(10), 2000);
});

Deno.test('canOverflow only offers the paid key for a distinct key slot', () => {
  assertEquals(canOverflow('paid', vault, vault.paid ?? ''), undefined);
  assertEquals(canOverflow('slotA', { ...vault, paid: undefined }, 'free-a-key'), undefined);
  assertEquals(canOverflow('slotA', vault, 'paid-key'), undefined);
  assertEquals(canOverflow('slotA', vault, 'free-a-key'), 'paid-key');
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
    requireKey({ ...vault, slotA: undefined }, 'slotA');
  } catch (err) {
    threw = err instanceof TheoremError && err.message === UPSTREAM_FAILED;
  }
  assertEquals(threw, true);
});

Deno.test('requireKey returns the key when present', () => {
  assertEquals(requireKey(vault, 'slotA'), 'free-a-key');
});

Deno.test('waitDefault returns a promise', () => {
  const result = waitDefault(0);
  assertEquals(typeof result.then, 'function');
});
