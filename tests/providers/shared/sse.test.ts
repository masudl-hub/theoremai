import { assertEquals } from '@std/assert';
import { readSseChunks, takeSsePayloads } from '../../../src/providers/shared/sse.ts';

Deno.test('SSE dispatches at blank lines and joins data lines', () => {
  const raw =
    ': comment\r\nevent:step.delta\r\ndata:{"text":\r\ndata: "hello"}\r\n\r\ndata: [DONE]\n\n';
  assertEquals(takeSsePayloads(raw).payloads, [
    { text: 'hello', sseEvent: 'step.delta' },
    { eventType: 'sse_done' },
  ]);
});
Deno.test('SSE retains a whole unfinished frame between byte chunks', () => {
  const first = takeSsePayloads('event: delta\ndata: {"text":"h');
  assertEquals(first.payloads, []);
  const second = takeSsePayloads(`${first.rest}i"}\n\n`);
  assertEquals(second.payloads, [{ text: 'hi', sseEvent: 'delta' }]);
});
Deno.test('SSE supports CR, CRLF and split CRLF boundaries', async () => {
  const chunks = ['data: {"a":1}\r', '\n\r', '\ndata: {"b":2}\r\rdata: {"c":3}\n\n'];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  assertEquals(await Array.fromAsync(readSseChunks(body)), [{ a: 1 }, { b: 2 }, { c: 3 }]);
});
Deno.test('empty data is not completion and EOF does not dispatch an incomplete frame', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data:\n\ndata: {"a":1}'));
      controller.close();
    },
  });
  assertEquals(await Array.fromAsync(readSseChunks(body)), [
    { eventType: 'sse_unparsed', data: '' },
  ]);
});
Deno.test('SSE preserves UTF-8 across bytes and releases the reader on early exit', async () => {
  let cancelled = false;
  const bytes = new TextEncoder().encode('data: {"text":"😀"}\n\n');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    },
    cancel() {
      cancelled = true;
    },
  });
  for await (const row of readSseChunks(body)) {
    assertEquals(row, { text: '😀' });
    break;
  }
  assertEquals(body.locked, false);
  assertEquals(cancelled, true);
});
