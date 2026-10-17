import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  bearer,
  checkBinding,
  createProviderRegistry,
  defineProvider,
  errorKind,
  openAi,
  type ProtocolRequest,
  resolveProviderLimits,
  z,
} from '../../mod.ts';
import { ProviderBudget } from '../../src/kernel/provider-budget.ts';
import { guardedCall } from '../../src/kernel/provider-runtime.ts';

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

Deno.test('the operation deadline aborts a credential resolver that does not cooperate', async () => {
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
      { protocol: 'openAi', provider: 'deadline-fixture', apiId: 'fixture' },
      'text',
    ),
    'text',
    {
      limits: { operationTimeoutMs: 10 },
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
  const error = await assertRejects(() => Array.fromAsync(call.complete(request)));
  assertEquals(errorKind(error), 'timeout');
  assert(signal?.aborted);
});
