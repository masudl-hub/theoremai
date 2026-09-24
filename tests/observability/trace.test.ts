import '../fixtures/test-host.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import { registerProfile } from '../../src/kernel/registry/profiles.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../src/kernel/types.ts';
import { jsonlSink, memorySink, noopSink } from '../../src/observability/trace.ts';
import { inlineContent, type TraceRecord } from '../../src/observability/trace-record.ts';
import type { TraceAttributes, TraceSpan } from '../../src/observability/trace-span.ts';
import { HOST_BINDINGS } from '../fixtures/models.ts';
import { STUB_WRITE, stubRecord } from '../fixtures/trace-record.ts';

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

/** Media the model returns: the record must hold its hash, never its bytes. */
const MEDIA_BASE64 = btoa('secret-bytes');

async function* fakeComplete(): AsyncGenerator<TurnEvent> {
  await Promise.resolve();
  yield { type: 'text', text: 'ok' };
  yield {
    type: 'media',
    media: { mimeType: 'image/jpeg', data: MEDIA_BASE64 },
  };
}

const fake: ModelProvider = { complete: fakeComplete };

function modelCall(record: TraceRecord): TraceSpan {
  const span = record.spans.find((s) => s.name.startsWith('generate_content'));
  if (!span) {
    throw new Error('no model call span');
  }
  return span;
}

Deno.test('runTurn traces projectId and hashes media not bytes', async () => {
  const into: TraceRecord[] = [];
  await collect(
    runTurn(
      {
        profile: 'image',
        projectId: 'proj-9',
        input: {
          text: 'fox',
          attachments: [{ mimeType: 'image/png', data: btoa('ex') }],
        },
      },
      fake,
      memorySink(into),
    ),
  );
  assertEquals(into.length, 1);
  const [record] = into;
  if (!record) {
    throw new Error('missing trace');
  }
  const [root] = record.spans;
  assertEquals(root?.attributes['theorem.project.id'], 'proj-9');
  assertEquals(root?.attributes['gen_ai.agent.name'], 'image');
  assertEquals(root?.status, { code: 'OK' });
  const [message] = (root?.attributes['gen_ai.input.messages'] ?? []) as {
    parts: TraceAttributes[];
  }[];
  const attachment = message?.parts.find((part) => part.type === 'blob');
  assertEquals(attachment?.mime_type, 'image/png');
  assertEquals(typeof attachment?.content_sha256, 'string');
  const call = modelCall(record);
  assertEquals(call.attributes['gen_ai.request.model'], 'gemini-3.1-flash-lite-image');
  assertEquals(call.attributes['gen_ai.output.type'], 'image');
  const [output] = call.attributes['gen_ai.output.messages'] as { parts: TraceAttributes[] }[];
  const media = output?.parts.find((part) => part.type === 'blob');
  assertEquals(media?.mime_type, 'image/jpeg');
  assertEquals(typeof media?.content_sha256, 'string');
  assertEquals(JSON.stringify(record).includes(MEDIA_BASE64), false);
});

Deno.test('runTurn records what the host received on the turn root, beside what the model wrote', async () => {
  registerProfile({
    type: 'text',
    id: 'trace_quiet_thoughts',
    identity: { handle: 'quiet', system: 'Reply briefly.' },
    models: { gemini35FlashLite: HOST_BINDINGS.gemini35FlashLite },
    maxSteps: 1,
    key: 'slotA',
    tools: { allow: [] },
    inputs: { text: true },
    outputs: { structured: null, streaming: { streamThoughts: false } },
  });
  const provider: ModelProvider = {
    async *complete() {
      await Promise.resolve();
      yield { type: 'thought', text: 'Private plan.' };
      yield { type: 'text', text: 'Water ' };
      yield { type: 'text', text: 'weekly.' };
      yield { type: 'structured', structured: { cadence: 'weekly' } };
      yield { type: 'done', stop: { kind: 'completed' } };
    },
  };
  const into: TraceRecord[] = [];
  await collect(
    runTurn(
      { profile: 'trace_quiet_thoughts', input: { text: 'fern?' } },
      provider,
      memorySink(into),
    ),
  );
  const [record] = into;
  if (!record) {
    throw new Error('missing trace');
  }
  const [root] = record.spans;
  // The profile keeps thoughts off the stream: the host never saw the plan.
  assertEquals(inlineContent(record, root?.attributes['gen_ai.output.messages']), [
    {
      role: 'assistant',
      parts: [
        { type: 'text', content: 'Water weekly.' },
        { type: 'structured', content: { cadence: 'weekly' } },
      ],
      finish_reason: 'stop',
    },
  ]);
  const [produced] = inlineContent(
    record,
    modelCall(record).attributes['gen_ai.output.messages'],
  ) as { parts: { type: string }[] }[];
  assertEquals(
    produced?.parts.map((part) => part.type),
    ['reasoning', 'text', 'structured'],
  );
});

Deno.test('runTurn traces explicit Interactions state controls', async () => {
  const into: TraceRecord[] = [];
  await collect(
    runTurn(
      {
        profile: 'chat',
        previousInteractionId: 'v1_prev',
        store: false,
        input: { text: 'continue' },
      },
      { complete: fakeComplete },
      memorySink(into),
    ),
  );
  const [record] = into;
  if (!record) {
    throw new Error('missing trace');
  }
  const call = modelCall(record);
  assertEquals(call.attributes['gen_ai.request.previous_response.id'], 'v1_prev');
  assertEquals(call.attributes['theorem.request.store'], false);
});

Deno.test('runTurn forwards Interactions state controls and preserves host metadata', async () => {
  const into: TraceRecord[] = [];
  const seen: ProviderCompleteRequest[] = [];
  const provider: ModelProvider = {
    async *complete(req) {
      seen.push(req);
      yield { type: 'text', text: 'continued' };
    },
  };

  await collect(
    runTurn(
      {
        profile: 'chat',
        previousInteractionId: 'v1_prev_2',
        store: true,
        metadata: {
          channel: 'imessage',
          deliveryPath: 'demo',
          nested: { untouched: true },
        },
        input: { text: 'continue with metadata' },
      },
      provider,
      memorySink(into),
    ),
  );

  assertEquals(seen[0]?.previousInteractionId, 'v1_prev_2');
  assertEquals(seen[0]?.store, true);
  assertEquals(into[0]?.metadata, {
    channel: 'imessage',
    deliveryPath: 'demo',
    nested: { untouched: true },
  });
});

Deno.test('jsonlSink rejects unsafe trace directories before filesystem access', () => {
  assertThrows(() => jsonlSink('traces'), Error, 'absolute');
  assertThrows(() => jsonlSink(`${Deno.cwd()}/traces`), Error, 'outside');
  assertThrows(
    () => jsonlSink(`${Deno.cwd()}/../${Deno.cwd().split('/').at(-1)}/traces`),
    Error,
    'outside',
  );
});

Deno.test('noopSink drops traces without filesystem access', async () => {
  await noopSink().write(stubRecord(), STUB_WRITE);
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A JSONL sink on 16/08/2026 over a directory holding one file from 01/01/2000. */
async function sinkWithStaleDay() {
  const dir = await Deno.makeTempDir();
  const stale = `${dir}/turns-2000-01-01.jsonl`;
  await Deno.writeTextFile(stale, '{}\n');
  const sink = jsonlSink(dir, { now: () => Date.parse('2026-08-16T00:00:00.000Z') });
  return { dir, stale, sink };
}

Deno.test('jsonl sink writes a day file and drops files past the record retention', async () => {
  const { dir, stale, sink } = await sinkWithStaleDay();
  await sink.write(stubRecord(), STUB_WRITE);
  assertEquals(await exists(stale), false);
  const today = await Deno.readTextFile(`${dir}/turns-2026-08-16.jsonl`);
  assertEquals(today.includes('"v":3'), true);
});

Deno.test('jsonl sink keeps every file when retention is 0 or less', async () => {
  for (const retainForDays of [0, -1]) {
    const { stale, sink } = await sinkWithStaleDay();
    await sink.write(stubRecord(), { retainForDays });
    assertEquals(await exists(stale), true);
  }
});
