import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../src/kernel/types.ts';
import { noopSink } from '../../src/observability/trace.ts';
import { inlineContent, type TraceRecord } from '../../src/observability/trace-record.ts';
import type { TraceAttributes, TraceSpan } from '../../src/observability/trace-span.ts';
import { HOST_BINDINGS } from '../fixtures/models.ts';
import { catalogedSink, catalogGate } from '../fixtures/trace-catalog.ts';
import { STUB_WRITE, stubRecord } from '../fixtures/trace-record.ts';

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
  const span = record.spans.find(
    (s) => s.name.startsWith('generate_content') || s.name.startsWith('chat '),
  );
  if (!span) {
    throw new Error('no model call span');
  }
  return span;
}
Deno.test('runTurn traces projectId and hashes media not bytes', async () => {
  const into: TraceRecord[] = [];
  await Array.fromAsync(
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
      catalogedSink(into),
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
  const [output] = call.attributes['gen_ai.output.messages'] as {
    parts: TraceAttributes[];
  }[];
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
  await Array.fromAsync(
    runTurn(
      { profile: 'trace_quiet_thoughts', input: { text: 'fern?' } },
      provider,
      catalogedSink(into),
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
  ) as {
    parts: {
      type: string;
    }[];
  }[];
  assertEquals(
    produced?.parts.map((part) => part.type),
    ['reasoning', 'text', 'structured'],
  );
});
Deno.test('runTurn preserves host metadata without forwarding vendor continuation fields', async () => {
  const into: TraceRecord[] = [];
  const seen: ProviderCompleteRequest[] = [];
  const provider: ModelProvider = {
    async *complete(req) {
      seen.push(req);
      yield { type: 'text', text: 'continued' };
    },
  };
  await Array.fromAsync(
    runTurn(
      {
        profile: 'chat',
        metadata: {
          channel: 'imessage',
          deliveryPath: 'demo',
          nested: { untouched: true },
        },
        input: { text: 'continue with metadata' },
      },
      provider,
      catalogedSink(into),
    ),
  );
  assertEquals(seen[0]?.previousInteractionId, undefined);
  assertEquals(seen[0]?.store, undefined);
  assertEquals(into[0]?.metadata, {
    channel: 'imessage',
    deliveryPath: 'demo',
    nested: { untouched: true },
  });
});
Deno.test('noopSink drops traces without filesystem access', async () => {
  await noopSink().write(stubRecord(), STUB_WRITE);
});
catalogGate();
