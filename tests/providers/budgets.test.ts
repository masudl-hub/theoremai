import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  bearer,
  checkBinding,
  createProviderRegistry,
  defineProvider,
  errorKind,
  openAi,
  type ProtocolRequest,
  providerLimitsSchema,
  z,
} from '../../mod.ts';
import { ProviderBudget } from '../../src/kernel/provider-budget.ts';
import { guardedCall } from '../../src/kernel/provider-runtime.ts';

Deno.test('provider budgets reject unsafe and overflowing timer values', () => {
  for (const operationTimeoutMs of [0, -1, Infinity, NaN, 0.5, 2147483648]) {
    assertThrows(() => providerLimitsSchema.parse({ operationTimeoutMs }));
  }
  assertThrows(() => providerLimitsSchema.parse({ maxStepEvents: Number.MAX_SAFE_INTEGER + 1 }));
});

Deno.test('normalized budgets count UTF-8 media and pending tools', () => {
  const bytes = new ProviderBudget(providerLimitsSchema.parse({ maxEventBytes: 40 }));
  try {
    assertThrows(() => bytes.event({ type: 'text', text: '😀'.repeat(10) }));
    assert(bytes.signal.aborted);
  } finally {
    bytes.stopTimer();
  }
  const calls = new ProviderBudget(providerLimitsSchema.parse({ maxPendingToolCalls: 1 }));
  try {
    calls.event({ type: 'tool_call', call: { name: 'tool', callId: 'one', arguments: {} } });
    assertThrows(() =>
      calls.event({ type: 'tool_call', call: { name: 'tool', callId: 'two', arguments: {} } }),
    );
  } finally {
    calls.stopTimer();
  }
});

Deno.test('HTTP attempts share decompressed consumption and cancel an oversized response', async () => {
  const budget = new ProviderBudget(providerLimitsSchema.parse({ maxWireResponseBytes: 8 }));
  let cancelled = 0;
  const fetch = budget.fetch(() =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('12345'));
          },
          cancel() {
            cancelled++;
          },
        }),
      ),
    ),
  );
  try {
    const first = await fetch('https://fixture.test');
    assert(first.body);
    const reader = first.body.getReader();
    await reader.read();
    await reader.cancel();
    const second = await fetch('https://fixture.test');
    const error = await assertRejects(() => second.text());
    assertEquals(errorKind(error), 'bad_response');
    assert(budget.signal.aborted);
    assertEquals(cancelled, 2);
  } finally {
    budget.stopTimer();
  }
});

Deno.test('fragmented SSE comments cannot exceed one wire-record budget', async () => {
  const budget = new ProviderBudget(providerLimitsSchema.parse({ maxWireRecordBytes: 8 }));
  try {
    const response = await budget.fetch(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(':1234'));
              controller.enqueue(new TextEncoder().encode('56789'));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      ),
    )('https://fixture.test');
    await assertRejects(() => response.text());
    assert(budget.signal.aborted);
  } finally {
    budget.stopTimer();
  }
});

Deno.test('a budget with no limits sets no timer and caps nothing', () => {
  const budget = new ProviderBudget(providerLimitsSchema.parse({}));
  try {
    assertEquals(budget.timeLeft(), Number.POSITIVE_INFINITY);
    budget.resumeOperation();
    budget.startLiveStep();
    assertEquals(budget.timeLeft(), Number.POSITIVE_INFINITY);
    budget.event({ type: 'text', text: 'x'.repeat(1_000_000) });
    for (let n = 0; n < 100; n++)
      budget.event({ type: 'tool_call', call: { name: 'tool', callId: `${n}`, arguments: {} } });
    assert(!budget.signal.aborted);
  } finally {
    budget.dispose();
  }
});

function stalledCall(
  modelLimits: Record<string, number> | undefined,
  hostLimits: Record<string, number> | undefined,
) {
  let signal: AbortSignal | undefined;
  const fixture = defineProvider({
    id: 'deadline-fixture',
    name: 'Deadline fixture',
    description: 'Signs with a key its resolver never gives.',
    key: z.string(),
    authorize: bearer(),
    serves: () => [{ protocol: openAi, baseUrl: 'https://deadline.test/v1' }],
  });
  const provider = createProviderRegistry().register(fixture, { keySlot: 'credential' });
  const call = guardedCall(
    provider,
    checkBinding(
      provider,
      {
        protocol: 'openAi',
        provider: 'deadline-fixture',
        apiId: 'fixture',
        ...(modelLimits ? { limits: modelLimits } : {}),
      },
      'text',
    ),
    'text',
    {
      ...(hostLimits ? { limits: hostLimits } : {}),
      vault: {
        credential: (context) => {
          signal = context.signal;
          return new Promise<string>(() => {});
        },
      },
      fetch: () => Promise.reject(new Error('no call should be sent')),
    },
    {},
  );
  const request = {
    system: '',
    input: [{ type: 'text', text: 'hi' }],
    builtins: [],
    structured: null,
    image: null,
  } as unknown as ProtocolRequest;
  return { run: () => Array.fromAsync(call.complete(request)), signal: () => signal };
}

Deno.test('the operation deadline aborts a credential resolver that does not cooperate', async () => {
  const call = stalledCall(undefined, { operationTimeoutMs: 10 });
  const error = await assertRejects(call.run);
  assertEquals(errorKind(error), 'timeout');
  assert(call.signal()?.aborted);
});

Deno.test("a model's own limits apply, and the host's override them field by field", async () => {
  const own = stalledCall({ operationTimeoutMs: 10 }, undefined);
  assertEquals(errorKind(await assertRejects(own.run)), 'timeout');
  const tighter = stalledCall({ operationTimeoutMs: 600_000 }, { operationTimeoutMs: 10 });
  assertEquals(errorKind(await assertRejects(tighter.run)), 'timeout');
  const looser = stalledCall({ operationTimeoutMs: 10 }, { operationTimeoutMs: 80 });
  const started = performance.now();
  assertEquals(errorKind(await assertRejects(looser.run)), 'timeout');
  assert(performance.now() - started >= 70);
});
