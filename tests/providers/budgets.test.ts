import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { defineProvider, errorKind, resolveProviderLimits, z } from '../../mod.ts';
import { ProviderBudget } from '../../src/kernel/provider-budget.ts';
import { createProviderOperations } from '../../src/kernel/provider-runtime.ts';

Deno.test('provider budgets reject unlimited, unsafe, and overflowing timer values', () => {
  for (const operationTimeoutMs of [0, -1, Infinity, NaN, 0.5, 2147483648]) {
    assertThrows(() => resolveProviderLimits({ operationTimeoutMs }));
  }
  assertThrows(() => resolveProviderLimits({ maxStepEvents: Number.MAX_SAFE_INTEGER + 1 }));
});

Deno.test('normalized budgets count UTF-8 media and pending tools', () => {
  const bytes = new ProviderBudget(resolveProviderLimits({ maxEventBytes: 40 }));
  try {
    assertThrows(() => bytes.event({ type: 'text', text: '😀'.repeat(10) }));
    assert(bytes.signal.aborted);
  } finally {
    bytes.stopTimer();
  }
  const calls = new ProviderBudget(resolveProviderLimits({ maxPendingToolCalls: 1 }));
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
  const budget = new ProviderBudget(resolveProviderLimits({ maxWireResponseBytes: 8 }));
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
  const budget = new ProviderBudget(resolveProviderLimits({ maxWireRecordBytes: 8 }));
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

Deno.test('provider setup deadline aborts a credential resolver that does not cooperate', async () => {
  let signal: AbortSignal | undefined;
  const provider = defineProvider({
    id: 'deadline-fixture',
    connection: {},
    keySlot: 'credential',
    adapter: {
      apiVersion: 1,
      id: 'deadline-fixture',
      connectionSchema: z.object({}),
      optionsSchema: z.object({}),
      credentialSchema: z.string(),
      capabilities: () => ({
        profileTypes: ['text'],
        inputKinds: ['text'],
        outputKinds: ['text'],
        builtins: [],
        features: {
          streaming: 'supported',
          clientTools: 'unsupported',
          parallelTools: 'unsupported',
          structuredOutput: 'unsupported',
          thinking: 'unsupported',
          summaries: 'unsupported',
          storedContinuation: 'unsupported',
        },
      }),
      validateRequest() {},
      async create(context) {
        await context.resolveCredential('primary');
        return {};
      },
    },
  });
  const error = await assertRejects(() =>
    createProviderOperations(
      provider,
      provider.model('fixture'),
      {
        limits: { operationTimeoutMs: 10 },
        vault: {
          credential: (context) => {
            signal = context.signal;
            return new Promise<string>(() => {});
          },
        },
      },
      {},
    ),
  );
  assertEquals(errorKind(error), 'timeout');
  assert(signal?.aborted);
});
