import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { describeError, z } from '../../mod.ts';
import { parseLiveClientMessage, readBody } from '../../web/src/server/mod.ts';
import { boundedRequestJson, requestByteLimit } from '../../web/src/server/request-body.ts';

Deno.test('request budget rejects dishonest content length before parsing and cancels the reader', async () => {
  let cancelled = 0;
  const request = new Request('https://fixture.test', {
    method: 'POST',
    headers: { 'content-length': '1' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"😀😀"}'));
      },
      cancel() {
        cancelled++;
      },
    }),
  });
  await assertRejects(() => boundedRequestJson(request, 16));
  assertEquals(cancelled, 1);
});

Deno.test('request decoding preserves multibyte characters fragmented across chunks', async () => {
  const bytes = new TextEncoder().encode('{"value":"😀"}');
  const request = new Request('https://fixture.test', {
    method: 'POST',
    body: new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }),
  });
  assertEquals(await boundedRequestJson(request, bytes.byteLength), { value: '😀' });
});

Deno.test('with no byte limit set, a body of any size is read', async () => {
  const value = 'x'.repeat(17 * 1024 * 1024);
  const request = new Request('https://fixture.test', {
    method: 'POST',
    body: JSON.stringify({ value }),
  });
  assertEquals(requestByteLimit(undefined), undefined);
  assertEquals(
    ((await boundedRequestJson(request, undefined)) as { value: string }).value.length,
    value.length,
  );
  assertEquals(parseLiveClientMessage(JSON.stringify({ type: 'text', text: value })), {
    type: 'text',
    text: value,
  });
  assertThrows(() => parseLiveClientMessage(JSON.stringify({ type: 'text', text: value }), 1024));
});

Deno.test('request byte limit cannot be disabled with zero or an unsafe integer', () => {
  for (const value of [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])
    assertThrows(() => requestByteLimit(value));
});

Deno.test('malformed browser JSON never enters host diagnostics', async () => {
  const secret = 'request-secret-NEVER-LOG';
  const text = `{"key":"${secret}",bad}`;
  const request = new Request('https://fixture.test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: text,
  });
  const http = await assertRejects(() => readBody(request, z.object({})));
  const live = assertThrows(() => parseLiveClientMessage(text));
  for (const error of [http, live]) {
    assert(!JSON.stringify(describeError(error)).includes(secret));
    assert(!String(error).includes(secret));
  }
});
