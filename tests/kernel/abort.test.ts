import '../fixtures/test-host.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../src/kernel/types.ts';
import { memorySink } from '../../src/observability/trace.ts';
import type { TraceRecord } from '../../src/observability/trace-record.ts';

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

Deno.test('runTurn emits cancelled done + post_turn when signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const provider: ModelProvider = {
    complete: () => {
      throw new Error('provider should not run');
    },
  };
  const events = await collect(
    runTurn({ profile: 'chat', input: { text: 'hi' }, signal: controller.signal }, provider),
  );
  assertEquals(
    events.some((e) => e.type === 'done' && e.stop?.kind === 'cancelled'),
    true,
  );
  assertEquals(events.at(-1)?.type, 'stage');
  assertEquals(events.at(-1)?.stage, 'post_turn');
});

Deno.test('runTurn cancels an in-flight provider and ends with cancelled done', async () => {
  const controller = new AbortController();
  const into: TraceRecord[] = [];
  let sawAbort = false;
  const provider: ModelProvider = {
    async *complete(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
      await new Promise<void>((_resolve, reject) => {
        const { signal } = req;
        if (!signal) {
          reject(new Error('missing signal'));
          return;
        }
        if (signal.aborted) {
          reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            sawAbort = true;
            reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
          },
          { once: true },
        );
        queueMicrotask(() => controller.abort());
      });
      yield { type: 'done' };
    },
  };

  const events = await collect(
    runTurn(
      { profile: 'chat', input: { text: 'hi' }, signal: controller.signal },
      provider,
      memorySink(into),
    ),
  );
  assertEquals(sawAbort, true);
  const [root] = into[0]?.spans ?? [];
  assertEquals(root?.attributes['theorem.stop.kind'], 'cancelled');
  assertEquals(root?.status, { code: 'UNSET' });
  assertEquals(
    events.some((e) => e.type === 'done' && e.stop?.kind === 'cancelled'),
    true,
  );
  assertEquals(events.at(-1)?.stage, 'post_turn');
});
