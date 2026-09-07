import '../../fixtures/test-host.ts';
import { OMIT_CANARY } from '../../../src/guardrails/canary.ts';
import { assertEquals } from '../../../src/kernel/engine/assert.ts';
import { runTurn } from '../../../src/kernel/engine/runner.ts';
import type { KeyVault, TurnEvent } from '../../../src/kernel/types.ts';
import { memorySink } from '../../../src/observability/trace.ts';
import type { TraceRecord } from '../../../src/observability/trace-record.ts';
import { camelToSnake } from '../../../src/providers/google/interactions/framing.ts';
import { createInteractionsProvider } from '../../../src/providers/google/interactions/stream.ts';
import {
  isImageBlob,
  redactCanaryInTree,
  scrubEntry,
  scrubRecord,
  scrubUpstream,
  tapeUpstream,
} from '../../../src/providers/shared/upstream-tape.ts';

const INPUT_TOKENS = 11;
const OUTPUT_TOKENS = 2;
const HTTP_OK = 200;

const vault: KeyVault = {
  slotA: 'free-a-key',
  slotB: 'free-b-key',
  slotC: 'free-c-key',
  paid: 'paid-key',
};

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

function assertFullTape(row: TraceRecord): void {
  const upstreamLog = row.upstreamLog as Record<string, unknown>[];
  const wire = row.wire as Record<string, unknown>;
  const usage = row.usage as Record<string, unknown>;
  const reqHeaders = upstreamLog[0]?.headers as Record<string, string>;
  assertEquals(upstreamLog[0]?.eventType, 'http_request');
  assertEquals(upstreamLog[0]?.method, 'POST');
  assertEquals(reqHeaders['x-goog-api-key'], '[redacted]');
  assertEquals(upstreamLog[1]?.eventType, 'http_response');
  assertEquals(upstreamLog[1]?.status, HTTP_OK);
  assertEquals(
    upstreamLog.some((item) => item.event_type === 'interaction.completed'),
    true,
  );
  assertEquals(
    upstreamLog.some((item) => item.eventType === 'sse_done'),
    true,
  );
  assertEquals(
    upstreamLog.some((item) => item.sseEvent === 'interaction.created'),
    true,
  );
  assertEquals(JSON.stringify(upstreamLog).includes('sig-blob'), true);
  assertEquals(row.previousInteractionId, null);
  assertEquals(row.store, null);
  assertEquals(row.streamed, true);
  assertEquals(row.title, 'hi');
  assertEquals(row.model, {
    id: 'gemini35FlashLite',
    apiId: 'gemini-3.5-flash-lite',
  });
  assertEquals(usage.total_input_tokens, INPUT_TOKENS);
  assertEquals(usage.total_output_tokens, OUTPUT_TOKENS);
  assertEquals(Object.hasOwn(wire, 'store'), false);
  assertEquals(typeof wire[camelToSnake('systemInstruction')], 'string');
  assertEquals(Object.hasOwn(wire, camelToSnake('previousInteractionId')), false);
  assertEquals(row.upstream?.id, 'v1_x');
  assertEquals(row.upstream?.finish, 'completed');
}

function sseResponse(events: unknown[]): Response {
  const blocks = events
    .map((event) => {
      const rec = event as Record<string, unknown>;
      const name = String(rec.event_type ?? 'message');
      return `event: ${name}\ndata: ${JSON.stringify(event)}\n`;
    })
    .join('\n');
  return new Response(`${blocks}\nevent: done\ndata: [DONE]\n`, {
    status: HTTP_OK,
  });
}

Deno.test('tapeUpstream hashes image data and redacts canary', async () => {
  const canary = 'theo-deadbeef';
  const raw = JSON.parse(
    '{"event_type":"step.delta","delta":{"type":"image","mime_type":"image/jpeg","data":"secret-bytes"},"note":"leaked theo-deadbeef"}',
  );
  const out = (await tapeUpstream(raw, canary)) as Record<string, unknown>;
  const delta = out.delta as Record<string, unknown>;
  assertEquals(delta.type, 'image');
  assertEquals(delta.dataKind, 'sha256');
  assertEquals(typeof delta.data, 'string');
  assertEquals(delta.data === 'secret-bytes', false);
  assertEquals(JSON.stringify(out).includes('secret-bytes'), false);
  assertEquals(JSON.stringify(out).includes(canary), false);
  assertEquals(JSON.stringify(out).includes(OMIT_CANARY), true);
});

Deno.test('tapeUpstream keeps usage and interaction id', async () => {
  const raw = JSON.parse(
    '{"event_type":"interaction.completed","interaction":{"id":"v1_abc","status":"completed","usage":{"total_input_tokens":11,"total_cached_tokens":0}}}',
  );
  const out = (await tapeUpstream(raw, '')) as Record<string, unknown>;
  const interaction = out.interaction as Record<string, unknown>;
  assertEquals(interaction.id, 'v1_abc');
  const usage = interaction.usage as Record<string, unknown>;
  assertEquals(usage.total_input_tokens, INPUT_TOKENS);
});

Deno.test('runTurn traces wire, usage, and every Interactions SSE row', async () => {
  const into: TraceRecord[] = [];
  const provider = createInteractionsProvider({
    vault,
    wait: () => Promise.resolve(),
    fetch: () =>
      Promise.resolve(
        sseResponse([
          JSON.parse(
            '{"event_type":"interaction.created","interaction":{"id":"v1_x","status":"in_progress"}}',
          ),
          JSON.parse(
            '{"event_type":"step.delta","delta":{"type":"thought_signature","signature":"sig-blob"}}',
          ),
          JSON.parse('{"event_type":"content.delta","delta":{"type":"text","text":"yo"}}'),
          JSON.parse(
            '{"event_type":"interaction.completed","interaction":{"id":"v1_x","status":"completed","usage":{"total_input_tokens":11,"total_output_tokens":2}}}',
          ),
        ]),
      ),
  });
  const events = await collect(
    runTurn({ profile: 'chat', input: { text: 'hi' } }, provider, memorySink(into)),
  );
  assertEquals(
    events.map((event) => event.type),
    ['text', 'tokens', 'error', 'done'],
  );
  const [row] = into;
  if (!row) {
    throw new Error('missing trace');
  }
  assertFullTape(row);
});

Deno.test('tapFetch handles non-Error thrown values and default fetch fallback', async () => {
  const { tapFetch } = await import('../../../src/providers/shared/upstream-tap.ts');
  const rows: Record<string, unknown>[] = [];
  const tap = (row: Record<string, unknown>) => rows.push(row);

  const customSend: typeof fetch = () => Promise.reject('raw string network crash');
  const tapped = tapFetch(tap, customSend);

  try {
    await tapped('https://example.com', { headers: { 'X-Secret-Token': 'supersecret' } });
  } catch {
    // Expected throw
  }

  const throwRow = rows.find((r) => r.eventType === 'http_throw');
  assertEquals(throwRow?.message, 'raw string network crash');
  assertEquals(throwRow?.name, 'Error');

  const reqRow = rows.find((r) => r.eventType === 'http_request');
  const headers = reqRow?.headers as Record<string, string>;
  assertEquals(headers['x-secret-token'], '[redacted]');
});

Deno.test('runTurn traces upstream error response bodies', async () => {
  const into: TraceRecord[] = [];
  const provider = createInteractionsProvider({
    vault,
    wait: () => Promise.resolve(),
    fetch: () => Promise.resolve(new Response('quota-detail', { status: 500 })),
  });
  await collect(runTurn({ profile: 'chat', input: { text: 'hi' } }, provider, memorySink(into)));
  const [row] = into;
  if (!row) {
    throw new Error('missing trace');
  }
  const upstreamLog = row.upstreamLog as Record<string, unknown>[];
  assertEquals(
    upstreamLog.some(
      (item) => item.eventType === 'http_error_body' && item.body === 'quota-detail',
    ),
    true,
  );
});

Deno.test('isImageBlob detects type image or media', () => {
  assertEquals(isImageBlob({ type: 'image' }), true);
  assertEquals(isImageBlob({ type: 'media' }), true);
  assertEquals(isImageBlob({ type: 'text' }), false);
});

Deno.test('isImageBlob detects mimeType or mime_type strings', () => {
  assertEquals(isImageBlob({ mimeType: 'image/png' }), true);
  assertEquals(isImageBlob({ mime_type: 'image/png' }), true);
  assertEquals(isImageBlob({ mimeType: 42 }), false);
  assertEquals(isImageBlob({}), false);
});

Deno.test('scrubEntry hashes data for image blobs', async () => {
  const rec = { type: 'image', data: 'bytes' };
  const [key, value] = await scrubEntry(rec, 'data', 'bytes');
  assertEquals(key, 'data');
  assertEquals(typeof value, 'string');
  assertEquals(value === 'bytes', false);
});

Deno.test('scrubEntry passes through non-data keys recursively', async () => {
  const rec = { type: 'text', note: 'hi' };
  const [key, value] = await scrubEntry(rec, 'note', 'hi');
  assertEquals(key, 'note');
  assertEquals(value, 'hi');
});

Deno.test('scrubEntry does not hash data when not an image blob', async () => {
  const rec = { type: 'text', data: 'plain' };
  const [key, value] = await scrubEntry(rec, 'data', 'plain');
  assertEquals(key, 'data');
  assertEquals(value, 'plain');
});

Deno.test('scrubRecord sets dataKind sha256 for image blobs with string data', async () => {
  const out = await scrubRecord({ type: 'image', mimeType: 'image/png', data: 'raw-bytes' });
  assertEquals(out.dataKind, 'sha256');
  assertEquals(typeof out.data, 'string');
  assertEquals(out.data === 'raw-bytes', false);
});

Deno.test('scrubRecord leaves dataKind unset for non-image records', async () => {
  const out = await scrubRecord({ type: 'text', data: 'plain' });
  assertEquals(Object.hasOwn(out, 'dataKind'), false);
  assertEquals(out.data, 'plain');
});

Deno.test('scrubUpstream recurses through arrays', async () => {
  const out = await scrubUpstream([{ type: 'text', data: 'x' }, 'plain-string', 5]);
  assertEquals(out, [{ type: 'text', data: 'x' }, 'plain-string', 5]);
});

Deno.test('scrubUpstream returns primitives unchanged', async () => {
  assertEquals(await scrubUpstream('plain'), 'plain');
  assertEquals(await scrubUpstream(5), 5);
  assertEquals(await scrubUpstream(null), null);
  assertEquals(await scrubUpstream(undefined), undefined);
});

Deno.test('redactCanaryInTree returns value unchanged when canary is empty', () => {
  const value = { note: 'leaked secret' };
  assertEquals(redactCanaryInTree(value, ''), value);
});

Deno.test('redactCanaryInTree replaces every canary occurrence in strings', () => {
  const value = { a: 'has secret and secret again', b: ['secret'] };
  const out = redactCanaryInTree(value, 'secret') as { a: string; b: string[] };
  assertEquals(out.a.includes('secret'), false);
  assertEquals(out.b[0]?.includes('secret'), false);
});
