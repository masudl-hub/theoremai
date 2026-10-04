import { assertEquals, assertRejects } from '@std/assert';
import {
  backoffMs,
  isTransientHttp,
  isTransientThrown,
  retryAfterMs,
  retryTransient,
  waitDefault,
} from '../../../src/providers/shared/retry.ts';

function recordWaits(): { waits: number[]; wait: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

function answering(...responses: (Response | Error)[]): {
  calls: () => number;
  send: typeof fetch;
} {
  let calls = 0;
  return {
    calls: () => calls,
    send: () => {
      const next = responses[Math.min(calls++, responses.length - 1)] as Response | Error;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next.clone());
    },
  };
}

Deno.test('isTransientHttp flags retryable status codes only', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assertEquals(isTransientHttp(status), true);
  for (const status of [200, 400, 401, 403, 404, 409, 501])
    assertEquals(isTransientHttp(status), false);
});

Deno.test('isTransientThrown matches known transient network error shapes', () => {
  assertEquals(isTransientThrown(new Error('dns lookup failed')), true);
  assertEquals(isTransientThrown(new Error('ECONNRESET')), true);
  assertEquals(isTransientThrown(new Error('fetch failed')), true);
  assertEquals(isTransientThrown(new Error('503 service unavailable')), true);
  assertEquals(isTransientThrown(new Error('socket hang up')), true);
  assertEquals(isTransientThrown(new Error('temporarily unavailable')), true);
  assertEquals(isTransientThrown(new TypeError('connection reset')), true);
  assertEquals(
    isTransientThrown(
      new TypeError(
        'error sending request for url (https://openrouter.ai/api/v1): client error (Connect): tcp connect error: Connection refused (os error 61)',
      ),
    ),
    true,
  );
});

Deno.test('isTransientThrown never retries an abort or a timeout', () => {
  assertEquals(
    isTransientThrown(new DOMException('The operation was aborted.', 'AbortError')),
    false,
  );
  assertEquals(isTransientThrown(new DOMException('network timed out', 'TimeoutError')), false);
});

Deno.test('isTransientThrown is false for unrelated errors', () => {
  assertEquals(isTransientThrown(new Error('invalid input')), false);
});

Deno.test('backoffMs waits 1s then 2s', () => {
  assertEquals(backoffMs(0), 1000);
  assertEquals(backoffMs(1), 2000);
  assertEquals(backoffMs(5), 2000);
});

Deno.test('retryAfterMs reads milliseconds, seconds or a date, up to a minute', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  const at = (init: Record<string, string>) => retryAfterMs(new Headers(init), now);
  assertEquals(at({}), undefined);
  assertEquals(at({ 'retry-after-ms': '250' }), 250);
  assertEquals(at({ 'retry-after-ms': '250', 'retry-after': '9' }), 250);
  assertEquals(at({ 'retry-after': '3' }), 3000);
  assertEquals(at({ 'retry-after': '0' }), 0);
  assertEquals(at({ 'retry-after': 'Sat, 03 Oct 2026 12:00:05 GMT' }), 5000);
  assertEquals(at({ 'retry-after': '60' }), 60_000);
  assertEquals(at({ 'retry-after': '61' }), undefined);
  assertEquals(at({ 'retry-after': '-1' }), undefined);
  assertEquals(at({ 'retry-after': 'Sat, 03 Oct 2026 11:59:00 GMT' }), undefined);
  assertEquals(at({ 'retry-after': 'soon' }), undefined);
  assertEquals(at({ 'retry-after': ' ' }), undefined);
});

Deno.test('retryTransient retries a transient status with backoff until it answers', async () => {
  const { waits, wait } = recordWaits();
  const upstream = answering(
    new Response('busy', { status: 503 }),
    new Response('busy', { status: 502 }),
    new Response('ok'),
  );
  const res = await retryTransient(upstream.send, wait)('https://x.test');
  assertEquals(res.status, 200);
  assertEquals(upstream.calls(), 3);
  assertEquals(waits, [1000, 2000]);
});

Deno.test('retryTransient waits what Retry-After asks, under a minute', async () => {
  const { waits, wait } = recordWaits();
  const upstream = answering(
    new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }),
    new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
    new Response('ok'),
  );
  await retryTransient(upstream.send, wait)('https://x.test');
  assertEquals(waits, [7000, 2000]);
});

Deno.test('retryTransient returns the third transient answer as it came', async () => {
  const { waits, wait } = recordWaits();
  const upstream = answering(new Response('quota', { status: 429 }));
  const res = await retryTransient(upstream.send, wait)('https://x.test');
  assertEquals(res.status, 429);
  assertEquals(await res.text(), 'quota');
  assertEquals(upstream.calls(), 3);
  assertEquals(waits, [1000, 2000]);
});

Deno.test('retryTransient sends a non-transient answer back at once', async () => {
  const { waits, wait } = recordWaits();
  for (const status of [200, 400, 401, 404]) {
    const upstream = answering(new Response('x', { status }));
    const res = await retryTransient(upstream.send, wait)('https://x.test');
    assertEquals(res.status, status);
    assertEquals(upstream.calls(), 1);
  }
  assertEquals(waits, []);
});

Deno.test('retryTransient retries a network failure and rethrows the last one', async () => {
  const { waits, wait } = recordWaits();
  const recovered = answering(new TypeError('fetch failed'), new Response('ok'));
  assertEquals((await retryTransient(recovered.send, wait)('https://x.test')).status, 200);
  assertEquals(recovered.calls(), 2);

  const down = answering(new TypeError('fetch failed'));
  const err = await assertRejects(
    () => retryTransient(down.send, wait)('https://x.test'),
    TypeError,
  );
  assertEquals(err.message, 'fetch failed');
  assertEquals(down.calls(), 3);
  assertEquals(waits, [1000, 1000, 2000]);
});

Deno.test('retryTransient rethrows a non-transient error without retrying', async () => {
  const upstream = answering(new Error('invalid input'));
  await assertRejects(() => retryTransient(upstream.send, recordWaits().wait)('https://x.test'));
  assertEquals(upstream.calls(), 1);
});

Deno.test('retryTransient stops waiting when the call is aborted', async () => {
  const controller = new AbortController();
  const upstream = answering(
    new Response('busy', { status: 503, headers: { 'retry-after': '30' } }),
  );
  const pending = retryTransient(upstream.send)('https://x.test', { signal: controller.signal });
  queueMicrotask(() => controller.abort(new DOMException('stop', 'AbortError')));
  const err = await assertRejects(() => pending, DOMException);
  assertEquals(err.name, 'AbortError');
  assertEquals(upstream.calls(), 1);
});

Deno.test('waitDefault resolves after the delay and rejects on abort', async () => {
  await waitDefault(0);
  const controller = new AbortController();
  controller.abort();
  await assertRejects(() => waitDefault(10, controller.signal), DOMException);
});
