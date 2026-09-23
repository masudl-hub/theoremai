import '../fixtures/test-host.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import { defineProfile, getProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import type { ModelProvider, TurnEvent } from '../../src/kernel/types.ts';
import {
  clearTraceDestinations,
  jsonlDestination,
  memorySink,
  registerTraceDestination,
  resolveObservabilityPolicy,
  resolveTraceWriter,
} from '../../src/observability/mod.ts';
import type { TraceRecord } from '../../src/observability/trace-record.ts';
import type { TraceSink, TraceWriteContext } from '../../src/observability/trace-sink.ts';
import { STUB_WRITE, stubRecord, stubSpan } from '../fixtures/trace-record.ts';

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

async function* fakeComplete(): AsyncGenerator<TurnEvent> {
  await Promise.resolve();
  yield { type: 'text', text: 'ok' };
}

const fake: ModelProvider = { complete: fakeComplete };

Deno.test('resolveObservabilityPolicy defaults scrub/include and record=false when omitted', () => {
  const policy = resolveObservabilityPolicy(undefined);
  assertEquals(policy.record, false);
  assertEquals(policy.sampleRate, 1);
  assertEquals(policy.include.upstreamLog, true);
  assertEquals(policy.include.outboundWire, true);
  assertEquals(policy.include.evidenceRaw, true);
  assertEquals(policy.include.usage, true);
  assertEquals(policy.include.guardrailDecisions, true);
  assertEquals(policy.include.guardrailMatchPreview, false);
  assertEquals(policy.scrub.sensitive, true);
  assertEquals(policy.scrub.injection, true);
  assertEquals(policy.scrub.canary, true);
  assertEquals(policy.retainForDays, 14);
  assertEquals(policy.rotateAfterMiB, 32);
});

Deno.test('authored observability defaults outboundWire/evidenceRaw off', () => {
  const policy = resolveObservabilityPolicy({ writeTo: false });
  assertEquals(policy.include.outboundWire, false);
  assertEquals(policy.include.evidenceRaw, false);
});

Deno.test('resolveObservabilityPolicy writeTo false means record false', () => {
  const policy = resolveObservabilityPolicy({ writeTo: false });
  assertEquals(policy.record, false);
});

Deno.test('resolveObservabilityPolicy rejects sampleRate outside 0–1', () => {
  assertThrows(
    () => resolveObservabilityPolicy({ writeTo: false, sampleRate: 1.5 }),
    Error,
    'sampleRate',
  );
});

Deno.test('resolveTraceWriter uses registered destination from writeTo id', async () => {
  clearTraceDestinations();
  const into: TraceRecord[] = [];
  registerTraceDestination('mem', memorySink(into));
  const { sink, policy } = resolveTraceWriter({
    observability: { writeTo: 'mem' },
  });
  assertEquals(policy.record, true);
  await sink.write(stubRecord(), STUB_WRITE);
  assertEquals(into.length, 1);
  clearTraceDestinations();
});

Deno.test('resolveTraceWriter sampleRate 0 drops writes; override sink ignores sampleRate', async () => {
  clearTraceDestinations();
  const sampled: TraceRecord[] = [];
  const forced: TraceRecord[] = [];
  registerTraceDestination('mem', memorySink(sampled));
  const stub = stubRecord();
  const dropped = resolveTraceWriter({
    observability: { writeTo: 'mem', sampleRate: 0 },
  });
  await dropped.sink.write(stub, STUB_WRITE);
  assertEquals(sampled.length, 0);

  const overridden = resolveTraceWriter({
    override: memorySink(forced),
    observability: { writeTo: 'mem', sampleRate: 0 },
  });
  await overridden.sink.write(stub, STUB_WRITE);
  assertEquals(forced.length, 1);
  clearTraceDestinations();
});

Deno.test('jsonlDestination rejects empty dir', () => {
  assertThrows(() => jsonlDestination('  '), Error, 'non-empty');
});

Deno.test('jsonlDestination rejects relative and checkout-local dirs', () => {
  assertThrows(() => jsonlDestination('traces'), Error, 'absolute');
  assertThrows(() => jsonlDestination(`${Deno.cwd()}/traces`), Error, 'outside');
});

Deno.test('registerTraceDestination revalidates raw jsonl descriptors', () => {
  clearTraceDestinations();
  assertThrows(
    () => registerTraceDestination('raw-jsonl', { kind: 'jsonl', dir: 'traces' }),
    Error,
    'absolute',
  );
  assertThrows(
    () =>
      registerTraceDestination('raw-jsonl', {
        kind: 'jsonl',
        dir: `${Deno.cwd()}/../${Deno.cwd().split('/').at(-1)}/traces`,
      }),
    Error,
    'outside',
  );
  clearTraceDestinations();
});

Deno.test('runTurn uses profile.observability.writeTo when sink omitted', async () => {
  clearTraceDestinations();
  const into: TraceRecord[] = [];
  registerTraceDestination('chat-mem', memorySink(into));
  const base = getProfile('chat');
  registerProfile(
    defineProfile({
      ...base,
      id: 'chat-obs',
      observability: { writeTo: 'chat-mem' },
    }),
  );
  await collect(
    runTurn(
      {
        profile: 'chat-obs',
        input: { text: 'hi' },
      },
      fake,
    ),
  );
  assertEquals(into.length, 1);
  assertEquals(into[0]?.spans[0]?.attributes['gen_ai.agent.name'], 'chat-obs');
  clearTraceDestinations();
});

Deno.test('every sink receives the retention of the profile that wrote the record', async () => {
  const seen: TraceWriteContext[] = [];
  const hostStore: TraceSink = {
    write: (_record, context) => {
      seen.push(context);
      return Promise.resolve();
    },
  };
  const base = getProfile('chat');
  registerProfile(
    defineProfile({
      ...base,
      id: 'chat-keep-forever',
      observability: { writeTo: hostStore, retainForDays: 0 },
    }),
  );
  const turn = { profile: 'chat-keep-forever', input: { text: 'hi' } };
  await collect(runTurn(turn, fake));
  await collect(runTurn(turn, fake, hostStore));
  assertEquals(seen, [{ retainForDays: 0 }, { retainForDays: 0 }]);
});

Deno.test('runTurn explicit sink overrides profile.observability', async () => {
  clearTraceDestinations();
  const profileInto: TraceRecord[] = [];
  const overrideInto: TraceRecord[] = [];
  registerTraceDestination('chat-mem', memorySink(profileInto));
  const base = getProfile('chat');
  registerProfile(
    defineProfile({
      ...base,
      id: 'chat-obs-override',
      observability: { writeTo: 'chat-mem' },
    }),
  );
  await collect(
    runTurn(
      {
        profile: 'chat-obs-override',
        input: { text: 'hi' },
      },
      fake,
      memorySink(overrideInto),
    ),
  );
  assertEquals(profileInto.length, 0);
  assertEquals(overrideInto.length, 1);
  clearTraceDestinations();
});

Deno.test('sampleRate keeps or drops every record of one trace together', async () => {
  clearTraceDestinations();
  const into: TraceRecord[] = [];
  registerTraceDestination('sampled', memorySink(into));
  const { sink } = resolveTraceWriter({ observability: { writeTo: 'sampled', sampleRate: 0.5 } });
  const record = (traceId: string, spanId: string): TraceRecord => ({
    ...stubRecord(),
    spans: [{ ...stubSpan(), traceId, spanId }],
  });
  // Low 32 bits: 0x10000000 is under half the space, 0xf0000000 is over it.
  const kept = '4bf92f3577b34da6a3ce929d10000000';
  const dropped = '4bf92f3577b34da6a3ce929df0000000';
  for (const traceId of [kept, dropped, kept, dropped]) {
    await sink.write(record(traceId, String(into.length).padStart(16, '0')), STUB_WRITE);
  }
  assertEquals(
    into.map((r) => r.spans[0]?.traceId),
    [kept, kept],
  );
  clearTraceDestinations();
});
