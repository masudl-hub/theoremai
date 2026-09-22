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
  await sink.write({
    v: 2,
    id: 't',
    ts: 1,
    ms: 1,
    streamed: true,
    cancelled: false,
    previousInteractionId: null,
    store: null,
    profile: 'x',
    input: { attachments: [], voice: [] },
    events: [],
    ok: true,
  });
  assertEquals(into.length, 1);
  clearTraceDestinations();
});

Deno.test('resolveTraceWriter sampleRate 0 drops writes; override sink ignores sampleRate', async () => {
  clearTraceDestinations();
  const sampled: TraceRecord[] = [];
  const forced: TraceRecord[] = [];
  registerTraceDestination('mem', memorySink(sampled));
  const stub: TraceRecord = {
    v: 2,
    id: 't',
    ts: 1,
    ms: 1,
    streamed: true,
    cancelled: false,
    previousInteractionId: null,
    store: null,
    profile: 'x',
    input: { attachments: [], voice: [] },
    events: [],
    ok: true,
  };
  const dropped = resolveTraceWriter({
    observability: { writeTo: 'mem', sampleRate: 0 },
  });
  await dropped.sink.write(stub);
  assertEquals(sampled.length, 0);

  const overridden = resolveTraceWriter({
    override: memorySink(forced),
    observability: { writeTo: 'mem', sampleRate: 0 },
  });
  await overridden.sink.write(stub);
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
  assertEquals(into[0]?.profile, 'chat-obs');
  clearTraceDestinations();
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
