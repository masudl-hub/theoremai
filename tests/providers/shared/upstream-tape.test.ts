import '../../fixtures/test-host.ts';
import { OMIT_CANARY } from '../../../src/guardrails/canary.ts';
import { assertEquals } from '../../../src/kernel/engine/assert.ts';
import { sha256 } from '../../../src/kernel/engine/hash.ts';
import { runTurn } from '../../../src/kernel/engine/runner.ts';
import type { KeyVault, TurnEvent } from '../../../src/kernel/types.ts';
import { contentOf, type TraceRecord } from '../../../src/observability/trace-record.ts';
import type { TraceAttributeValue, TraceSpan } from '../../../src/observability/trace-span.ts';
import { camelToSnake } from '../../../src/providers/google/interactions/framing.ts';
import { createInteractionsProvider } from '../../../src/providers/google/interactions/stream.ts';
import {
  inlineBytesKey,
  redactCanaryInTree,
  scrubRecord,
  scrubUpstream,
  tapeUpstream,
} from '../../../src/providers/shared/upstream-tape.ts';
import { catalogedSink, catalogGate } from '../../fixtures/trace-catalog.ts';

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

function spanNamed(record: TraceRecord, name: string): TraceSpan {
  const span = record.spans.find((s) => s.name === name);
  if (!span) {
    throw new Error(`no span ${name}`);
  }
  return span;
}

/** Every event of `name` on `span`, its `key` attribute read back from content. */
function eventContent(record: TraceRecord, span: TraceSpan, name: string, key: string): unknown[] {
  return span.events
    .filter((event) => event.name === name)
    .map((event) => JSON.parse(contentOf(record, event.attributes[key]) ?? 'null'));
}

function assertFullTape(record: TraceRecord): void {
  const call = spanNamed(record, 'generate_content gemini-3.5-flash-lite');
  const post = spanNamed(record, 'POST');
  assertEquals(post.parentSpanId, call.spanId);
  assertEquals(post.attributes['http.request.header.x-goog-api-key'], ['[redacted]']);
  assertEquals(post.attributes['http.response.status_code'], HTTP_OK);
  // The body was a 200; the call failed on its content, not the try.
  assertEquals(post.status, { code: 'OK' });
  const rows = eventContent(record, call, 'theorem.upstream.row', 'row') as Record<
    string,
    unknown
  >[];
  assertEquals(
    rows.map((row) => row.sseEvent),
    ['interaction.created', 'step.delta', 'step.delta', 'interaction.completed', 'done'],
  );
  assertEquals(JSON.stringify(rows).includes('sig-blob'), true);
  assertEquals(call.attributes['theorem.model.id'], 'gemini35FlashLite');
  assertEquals(call.attributes['gen_ai.usage.input_tokens'], INPUT_TOKENS);
  assertEquals(call.attributes['gen_ai.usage.output_tokens'], OUTPUT_TOKENS);
  assertEquals(call.attributes['gen_ai.response.id'], 'v1_x');
  const [wire] = eventContent(record, post, 'theorem.wire.request', 'body') as Record<
    string,
    unknown
  >[];
  assertEquals(Object.hasOwn(wire ?? {}, 'store'), false);
  assertEquals(Object.hasOwn(wire ?? {}, camelToSnake('previousInteractionId')), false);
  // The wire's system text is the recorded instruction, stored once and referenced.
  const [system] = call.attributes['gen_ai.system_instructions'] as TraceAttributeValue[];
  assertEquals(
    (wire?.[camelToSnake('systemInstruction')] as Record<string, unknown> | undefined)
      ?.content_sha256,
    (system as Record<string, unknown>).content_sha256,
  );
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
  const canary = 'deadbeeffeedfacecafebabecafebabe';
  const raw = JSON.parse(
    '{"event_type":"step.delta","delta":{"type":"image","mime_type":"image/jpeg","data":"c2VjcmV0LWJ5dGVz"},"note":"leaked deadbeeffeedfacecafebabecafebabe"}',
  );
  const out = (await tapeUpstream(raw, [canary])) as Record<string, unknown>;
  const delta = out.delta as Record<string, unknown>;
  assertEquals(delta.type, 'image');
  assertEquals(delta.dataKind, 'sha256');
  assertEquals(typeof delta.data, 'string');
  assertEquals(delta.data === 'c2VjcmV0LWJ5dGVz', false);
  assertEquals(JSON.stringify(out).includes('c2VjcmV0LWJ5dGVz'), false);
  assertEquals(JSON.stringify(out).includes(canary), false);
  assertEquals(JSON.stringify(out).includes(OMIT_CANARY), true);
});

Deno.test('tapeUpstream keeps usage and interaction id', async () => {
  const raw = JSON.parse(
    '{"event_type":"interaction.completed","interaction":{"id":"v1_abc","status":"completed","usage":{"total_input_tokens":11,"total_cached_tokens":0}}}',
  );
  const out = (await tapeUpstream(raw, [])) as Record<string, unknown>;
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
          JSON.parse('{"event_type":"step.delta","index":0,"delta":{"type":"text","text":"yo"}}'),
          JSON.parse(
            '{"event_type":"interaction.completed","interaction":{"id":"v1_x","status":"completed","usage":{"total_input_tokens":11,"total_output_tokens":2}}}',
          ),
        ]),
      ),
  });
  const events = await collect(
    runTurn({ profile: 'chat', input: { text: 'hi' } }, provider, catalogedSink(into)),
  );
  // Text profiles always emit turn stages (`pre_turn` → … → `post_turn`) even
  // when the turn passes no `onStage` handler.
  assertEquals(
    events.map((event) => event.type),
    ['stage', 'text', 'error', 'tokens', 'stage', 'done', 'stage'],
  );
  assertEquals(
    events.filter((e) => e.type === 'stage').map((e) => e.stage),
    ['pre_turn', 'before_end', 'post_turn'],
  );
  const [record] = into;
  if (!record) {
    throw new Error('missing trace');
  }
  assertFullTape(record);
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
  await collect(runTurn({ profile: 'chat', input: { text: 'hi' } }, provider, catalogedSink(into)));
  const [record] = into;
  if (!record) {
    throw new Error('missing trace');
  }
  const post = spanNamed(record, 'POST');
  assertEquals(post.status, { code: 'ERROR', message: '500' });
  assertEquals(eventContent(record, post, 'theorem.upstream.row', 'row'), [
    { eventType: 'http_error_body', body: 'quota-detail' },
  ]);
});

Deno.test('inlineBytesKey finds the bytes of each observed wire shape', () => {
  assertEquals(inlineBytesKey({ type: 'image', mime_type: 'image/png', data: 'x' }), 'data');
  assertEquals(inlineBytesKey({ type: 'audio', mime_type: 'audio/l16', data: 'x' }), 'data');
  assertEquals(inlineBytesKey({ b64_json: 'x', media_type: 'image/jpeg' }), 'b64_json');
  assertEquals(inlineBytesKey({ mimeType: 'image/png', data: 'x' }), 'data');
  assertEquals(inlineBytesKey({ mime_type: 'image/png' }), undefined);
  assertEquals(inlineBytesKey({ type: 'image', data: 'x' }), undefined);
  assertEquals(inlineBytesKey({ b64_json: 'x' }), undefined);
  assertEquals(inlineBytesKey({}), undefined);
});

Deno.test('scrubRecord hashes mime_type data and marks the record', async () => {
  const out = await scrubRecord({ type: 'image', mime_type: 'image/png', data: 'cmF3LWJ5dGVz' });
  assertEquals(out.data, await sha256('raw-bytes'));
  assertEquals(out.dataKind, 'sha256');
  assertEquals(out.mime_type, 'image/png');
});

Deno.test('scrubRecord hashes an images endpoint b64_json entry', async () => {
  const out = await scrubRecord({ b64_json: 'cmF3LWJ5dGVz', media_type: 'image/jpeg' });
  assertEquals(out.b64_json, await sha256('raw-bytes'));
  assertEquals(out.dataKind, 'sha256');
});

Deno.test('scrubUpstream hashes a base64 data url wherever it sits', async () => {
  const out = await scrubUpstream({
    images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,cmF3LWJ5dGVz' } }],
  });
  assertEquals(out, {
    images: [
      {
        type: 'image_url',
        image_url: { url: `data:image/png;sha256,${await sha256('raw-bytes')}` },
      },
    ],
  });
});

Deno.test('inline data that is not base64 is hashed as text and labelled', async () => {
  const out = await scrubUpstream({
    part: { mime_type: 'image/png', data: 'not base64!' },
    url: 'data:image/png;base64,not base64!',
  });
  const hash = await sha256('not base64!');
  assertEquals(out, {
    part: { mime_type: 'image/png', data: hash, dataKind: 'text_sha256' },
    url: `data:image/png;text_sha256,${hash}`,
  });
});

Deno.test('scrubRecord keeps data without a mime_type and adds no marker', async () => {
  const out = await scrubRecord({ type: 'reasoning.encrypted', data: 'opaque' });
  assertEquals(out, { type: 'reasoning.encrypted', data: 'opaque' });
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

Deno.test('redactCanaryInTree returns value unchanged with no canaries', () => {
  const value = { note: 'leaked secret' };
  assertEquals(redactCanaryInTree(value, []), value);
});

Deno.test('redactCanaryInTree replaces every canary occurrence in strings', () => {
  const value = { a: 'has secret and secret again', b: ['secret'] };
  const out = redactCanaryInTree(value, ['secret']) as { a: string; b: string[] };
  assertEquals(out.a.includes('secret'), false);
  assertEquals(out.b[0]?.includes('secret'), false);
});

catalogGate();
