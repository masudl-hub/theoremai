/**
 * Record builder: scrub, canaries, include flags, interning, bytes, and the policy stamp.
 */
import { OMIT_CANARY } from '../../src/guardrails/canary.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { sha256 } from '../../src/kernel/engine/hash.ts';
import { resolveObservabilityPolicy } from '../../src/observability/resolve-policy.ts';
import {
  buildRecord,
  contentOf,
  inlineContent,
  TRACE_SCHEMA_URL,
} from '../../src/observability/trace-record.ts';
import {
  startTrace,
  type TraceAttributes,
  traceBytes,
  traceContent,
  traceJson,
} from '../../src/observability/trace-span.ts';
import type { ProfileObservabilitySpec } from '../../src/observability/types.ts';

const CANARY = 'CANARY-7f3a';
const SECRET = 'sk-abcdefghijklmnopqrstuvwx';

/** One closed root span holding `attributes`, with `events` on it. */
function spansOf(attributes: TraceAttributes, events: [string, TraceAttributes][] = []) {
  const tree = startTrace('invoke_agent chat', { attributes });
  for (const [name, eventAttributes] of events) {
    tree.root.event(name, eventAttributes);
  }
  tree.root.end();
  return tree.collect();
}

function build(
  attributes: TraceAttributes,
  spec: ProfileObservabilitySpec = { writeTo: false },
  events: [string, TraceAttributes][] = [],
) {
  return buildRecord({
    spans: spansOf(attributes, events),
    policy: resolveObservabilityPolicy(spec),
    canaries: [CANARY],
  });
}

Deno.test('content is scrubbed, canary-free, and stored once by hash', async () => {
  const text = `key ${SECRET} ${CANARY}`;
  const record = await build({ a: traceContent(text), b: traceContent(text) });
  const [root] = record.spans;
  const stored = `key [omitted -sensitive] ${OMIT_CANARY}`;
  assertEquals(contentOf(record, root?.attributes.a), stored);
  assertEquals(root?.attributes.a, root?.attributes.b);
  assertEquals(record.content, { [await sha256(stored)]: stored });
});

Deno.test('scrub switched off stores the text exactly', async () => {
  const text = `key ${SECRET} ${CANARY}`;
  const record = await build(
    { a: traceContent(text) },
    { writeTo: false, scrub: { sensitive: false, injection: false, canary: false } },
  );
  assertEquals(contentOf(record, record.spans[0]?.attributes.a), text);
  assertEquals(record.spans[0]?.attributes['theorem.record.scrub'], []);
});

Deno.test('marker siblings survive resolution', async () => {
  const record = await build({ part: { ...traceContent('hi'), type: 'text' } });
  const part = record.spans[0]?.attributes.part;
  assertEquals(part, { type: 'text', content_sha256: await sha256('hi') });
});

Deno.test('bytes are hashed over the raw bytes and never stored', async () => {
  const base64 = btoa('raw-bytes');
  const record = await build({ blob: { ...traceBytes(base64), mime_type: 'image/png' } });
  assertEquals(record.spans[0]?.attributes.blob, {
    mime_type: 'image/png',
    content_sha256: await sha256('raw-bytes'),
    bytes: 'raw-bytes'.length,
  });
  assertEquals(JSON.stringify(record).includes(base64), false);
});

Deno.test('bytes that are not base64 are labelled, and the record survives', async () => {
  const record = await build({ blob: traceBytes('not base64!'), kept: 'yes' });
  const [root] = record.spans;
  assertEquals(root?.attributes.blob, {
    invalid_base64: true,
    text_sha256: await sha256('not base64!'),
  });
  assertEquals(root?.attributes.kept, 'yes');
});

Deno.test('rows intern strings equal to recorded text and hash their media', async () => {
  const record = await build({}, { writeTo: false }, [
    ['theorem.input', { text: traceContent('hello') }],
    [
      'theorem.upstream.row',
      {
        row: traceJson({
          prompt: 'hello',
          image: { mime_type: 'image/png', data: btoa('px') },
          note: `leak ${CANARY}`,
        }),
      },
    ],
  ]);
  const row = record.spans[0]?.events[1]?.attributes.row;
  assertEquals(JSON.parse(contentOf(record, row) ?? 'null'), {
    prompt: { content_sha256: await sha256('hello') },
    image: { mime_type: 'image/png', data: await sha256('px'), dataKind: 'sha256' },
    note: `leak ${OMIT_CANARY}`,
  });
});

Deno.test('references say how to read them, and inlineContent rebuilds every one', async () => {
  const pixels = btoa('px');
  const record = await build(
    {
      'gen_ai.input.messages': [
        {
          role: 'user',
          parts: [
            { type: 'text', ...traceContent('hello') },
            { type: 'blob', mime_type: 'image/png', ...traceBytes(pixels) },
          ],
        },
      ],
      call: { type: 'server_tool_call', ...traceJson({ query: 'hello' }) },
    },
    { writeTo: false },
    [['theorem.upstream.row', { row: traceJson({ prompt: 'hello', n: 1 }) }]],
  );
  const [root] = record.spans;
  const row = root?.events[0]?.attributes.row;
  assertEquals(row, {
    json_sha256: await sha256(
      JSON.stringify({ prompt: { content_sha256: await sha256('hello') }, n: 1 }),
    ),
  });
  assertEquals(inlineContent(record, row), { prompt: 'hello', n: 1 });
  assertEquals(inlineContent(record, root?.attributes.call), {
    query: 'hello',
    type: 'server_tool_call',
  });
  assertEquals(inlineContent(record, root?.attributes['gen_ai.input.messages']), [
    {
      role: 'user',
      parts: [
        { type: 'text', content: 'hello' },
        // Bytes were never stored: the blob keeps its hash.
        { type: 'blob', mime_type: 'image/png', content_sha256: await sha256('px'), bytes: 2 },
      ],
    },
  ]);
});

Deno.test('include flags drop the families they govern', async () => {
  const guardrail = { hits: [{ rule: 'pii', match: SECRET }] };
  const events: [string, TraceAttributes][] = [
    ['theorem.upstream.row', { row: traceJson({ a: 1 }) }],
    ['theorem.wire.request', { body: traceJson({ b: 2 }) }],
    ['theorem.grounding', { sources: ['s'], raw: traceJson({ c: 3 }) }],
    ['theorem.guardrail', guardrail],
  ];
  const usage = { 'gen_ai.usage.input_tokens': 3, 'theorem.usage.cost': 1, other: true };
  const off = await build(
    usage,
    {
      writeTo: false,
      include: {
        upstreamLog: false,
        outboundWire: false,
        usage: false,
        evidenceRaw: false,
        guardrailMatchPreview: false,
      },
    },
    events,
  );
  const [root] = off.spans;
  assertEquals(root?.attributes.other, true);
  assertEquals('gen_ai.usage.input_tokens' in (root?.attributes ?? {}), false);
  assertEquals('theorem.usage.cost' in (root?.attributes ?? {}), false);
  assertEquals(
    root?.events.map((e) => [e.name, e.attributes]),
    [
      ['theorem.grounding', { sources: ['s'] }],
      ['theorem.guardrail', { hits: [{ rule: 'pii' }] }],
    ],
  );
  assertEquals(root?.attributes['theorem.record.include'], ['guardrailDecisions']);

  const on = await build(
    usage,
    {
      writeTo: false,
      include: { outboundWire: true, evidenceRaw: true, guardrailMatchPreview: true },
    },
    events,
  );
  const [full] = on.spans;
  assertEquals(full?.attributes['gen_ai.usage.input_tokens'], 3);
  assertEquals(full?.events.length, events.length);
  assertEquals(full?.events[3]?.attributes, guardrail);
});

Deno.test('the root alone carries the policy, and the record its envelope', async () => {
  const tree = startTrace('root');
  tree.root.child('child').end();
  tree.root.end();
  const record = await buildRecord({
    spans: tree.collect(),
    policy: resolveObservabilityPolicy({ writeTo: false, resource: { 'service.name': 'svc' } }),
    metadata: { channel: 'web' },
  });
  assertEquals(record.v, 3);
  assertEquals(record.schemaUrl, TRACE_SCHEMA_URL);
  assertEquals(record.resource, { 'service.name': 'svc' });
  assertEquals(record.metadata, { channel: 'web' });
  assertEquals(record.spans[0]?.attributes['theorem.record.scrub'], [
    'sensitive',
    'injection',
    'canary',
  ]);
  assertEquals(record.spans[1]?.attributes, {});
});
