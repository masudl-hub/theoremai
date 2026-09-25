/**
 * OTLP/JSON export: a pure reshape of v3 records, with stored content inlined.
 */
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { toOtlpJson } from '../../src/observability/otlp.ts';
import { resolveObservabilityPolicy } from '../../src/observability/resolve-policy.ts';
import { buildRecord } from '../../src/observability/trace-record.ts';
import {
  startTrace,
  traceBytes,
  traceContent,
  traceJson,
} from '../../src/observability/trace-span.ts';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

async function turnRecord(metadata?: Record<string, unknown>) {
  let now = 1_000n;
  const tree = startTrace('invoke_agent support', {
    traceparent: TRACEPARENT,
    clock: { nowUnixNano: () => (now += 1_000n) },
    attributes: { 'gen_ai.agent.name': 'support', 'gen_ai.usage.input_tokens': 12, ratio: 0.5 },
    links: [{ traceparent: TRACEPARENT, attributes: { 'theorem.link.kind': 'resume' } }],
  });
  const chat = tree.root.child('chat gemini-3.8-flash', {
    kind: 'CLIENT',
    attributes: {
      'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', ...traceContent('hi') }] }],
      'theorem.stream': true,
      absent: null,
    },
  });
  chat.event('theorem.upstream.row', { row: traceJson({ echo: 'hi' }) });
  chat.event('theorem.media', { image: { mime_type: 'image/png', ...traceBytes(btoa('px')) } });
  chat.end({ code: 'ERROR', message: 'unclosed' });
  tree.root.end({ code: 'OK' });
  return await buildRecord({
    spans: tree.collect(),
    policy: resolveObservabilityPolicy({ writeTo: false, resource: { 'service.name': 'harbor' } }),
    ...(metadata ? { metadata } : {}),
  });
}

Deno.test('toOtlpJson reshapes a record into one resource, one scope, its spans', async () => {
  const record = await turnRecord();
  const [resourceSpans] = toOtlpJson([record]).resourceSpans;
  assertEquals(resourceSpans?.resource.attributes, [
    { key: 'service.name', value: { stringValue: 'harbor' } },
  ]);
  const [scope] = resourceSpans?.scopeSpans ?? [];
  assertEquals(scope?.scope, { name: '@theoremai/agents' });
  assertEquals(scope?.schemaUrl, record.schemaUrl);
  const [root, chat] = scope?.spans ?? [];
  assertEquals(root?.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assertEquals(root?.parentSpanId, '00f067aa0ba902b7');
  assertEquals(chat?.parentSpanId, root?.spanId);
  assertEquals([root?.kind, chat?.kind], [1, 3]);
  assertEquals([root?.status, chat?.status], [{ code: 1 }, { code: 2, message: 'unclosed' }]);
  assertEquals(root?.links, [
    {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      attributes: [{ key: 'theorem.link.kind', value: { stringValue: 'resume' } }],
    },
  ]);
  assertEquals(
    root?.attributes.filter(
      (kv) => kv.key !== 'theorem.record.include' && kv.key !== 'theorem.record.scrub',
    ),
    [
      { key: 'gen_ai.agent.name', value: { stringValue: 'support' } },
      { key: 'gen_ai.usage.input_tokens', value: { intValue: '12' } },
      { key: 'ratio', value: { doubleValue: 0.5 } },
    ],
  );
});

Deno.test('toOtlpJson inlines stored content so viewers read semconv messages', async () => {
  const record = await turnRecord();
  const chat = toOtlpJson([record]).resourceSpans[0]?.scopeSpans[0]?.spans[1];
  assertEquals(chat?.attributes, [
    {
      key: 'gen_ai.input.messages',
      value: {
        arrayValue: {
          values: [
            {
              kvlistValue: {
                values: [
                  { key: 'role', value: { stringValue: 'user' } },
                  {
                    key: 'parts',
                    value: {
                      arrayValue: {
                        values: [
                          {
                            kvlistValue: {
                              values: [
                                { key: 'type', value: { stringValue: 'text' } },
                                { key: 'content', value: { stringValue: 'hi' } },
                              ],
                            },
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    },
    { key: 'theorem.stream', value: { boolValue: true } },
  ]);
  assertEquals(chat?.events[0]?.attributes, [
    {
      key: 'row',
      value: { kvlistValue: { values: [{ key: 'echo', value: { stringValue: 'hi' } }] } },
    },
  ]);
});

Deno.test("toOtlpJson keeps a blob's hash: its bytes were never stored", async () => {
  const record = await turnRecord();
  const chat = toOtlpJson([record]).resourceSpans[0]?.scopeSpans[0]?.spans[1];
  const image = chat?.events[1]?.attributes[0]?.value;
  const fields = image && 'kvlistValue' in image ? image.kvlistValue.values : [];
  assertEquals(
    fields.map((kv) => kv.key),
    ['mime_type', 'content_sha256', 'bytes'],
  );
  assertEquals(fields[2]?.value, { intValue: '2' });
});

Deno.test('toOtlpJson puts host metadata on the top span only', async () => {
  const record = await turnRecord({ ticket: 'HS-2291', retries: 2, tags: ['vip'], none: null });
  const [root, chat] = toOtlpJson([record]).resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
  // The root's parent is the host's traceparent span, outside the record.
  assertEquals(root?.parentSpanId, '00f067aa0ba902b7');
  assertEquals(
    root?.attributes.filter((kv) => kv.key.startsWith('theorem.metadata.')),
    [
      { key: 'theorem.metadata.ticket', value: { stringValue: 'HS-2291' } },
      { key: 'theorem.metadata.retries', value: { intValue: '2' } },
      {
        key: 'theorem.metadata.tags',
        value: { arrayValue: { values: [{ stringValue: 'vip' }] } },
      },
    ],
  );
  assertEquals(
    chat?.attributes.some((kv) => kv.key.startsWith('theorem.metadata.')),
    false,
  );
});
