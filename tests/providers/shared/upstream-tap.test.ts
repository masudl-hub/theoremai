import { assertEquals } from '../../../src/kernel/engine/assert.ts';
import {
  tapeHeaders,
  tapeHeaderValue,
  tapFetch,
  throwRow,
} from '../../../src/providers/shared/upstream-tap.ts';

Deno.test('tapeHeaderValue redacts secret-looking header names', () => {
  assertEquals(tapeHeaderValue('Authorization', 'Bearer abc'), '[redacted]');
  assertEquals(tapeHeaderValue('x-api-key', 'k'), '[redacted]');
  assertEquals(tapeHeaderValue('Cookie', 'a=b'), '[redacted]');
  assertEquals(tapeHeaderValue('x-goog-secret', 's'), '[redacted]');
  assertEquals(tapeHeaderValue('X-Auth-Token', 't'), '[redacted]');
});

Deno.test('tapeHeaderValue passes through non-secret header values', () => {
  assertEquals(tapeHeaderValue('content-type', 'application/json'), 'application/json');
  assertEquals(tapeHeaderValue('accept', '*/*'), '*/*');
});

Deno.test('tapeHeaders redacts secret headers and lowercases keys', () => {
  const headers = tapeHeaders({
    'X-Goog-Api-Key': 'secret-value',
    'Content-Type': 'application/json',
  });
  assertEquals(headers['x-goog-api-key'], '[redacted]');
  assertEquals(headers['content-type'], 'application/json');
});

Deno.test('tapeHeaders handles undefined headers', () => {
  assertEquals(tapeHeaders(undefined), {});
});

Deno.test('throwRow builds a row from an Error instance', () => {
  const row = throwRow(new TypeError('boom'));
  assertEquals(row, { eventType: 'http_throw', name: 'TypeError', message: 'boom' });
});

Deno.test('throwRow builds a row from a non-Error thrown value', () => {
  const row = throwRow('raw string crash');
  assertEquals(row, { eventType: 'http_throw', name: 'Error', message: 'raw string crash' });
});

Deno.test('throwRow stringifies non-Error, non-string thrown values', () => {
  const row = throwRow({ code: 42 });
  assertEquals(row.eventType, 'http_throw');
  assertEquals(row.name, 'Error');
  assertEquals(typeof row.message, 'string');
});

Deno.test('tapFetch uses the default global fetch when no send is provided', async () => {
  const rows: Record<string, unknown>[] = [];
  const tap = (row: Record<string, unknown>) => rows.push(row);
  const originalFetch = globalThis.fetch;
  const stub: typeof fetch = () =>
    Promise.resolve(new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
  globalThis.fetch = stub;
  try {
    const tapped = tapFetch(tap);
    const res = await tapped('https://example.com/default-fetch');
    assertEquals(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assertEquals(
    rows.some((row) => row.eventType === 'http_request' && row.method === 'GET'),
    true,
  );
  assertEquals(
    rows.some((row) => row.eventType === 'http_response'),
    true,
  );
});

Deno.test('tapFetch does not call tap when tap is undefined', async () => {
  const send: typeof fetch = () => Promise.resolve(new Response('ok', { status: 200 }));
  const tapped = tapFetch(undefined, send);
  const res = await tapped('https://example.com/no-tap');
  assertEquals(res.status, 200);
});
