/**
 * A call's response identity reaches its trace span even when the call fails
 * or a guardrail cuts it, and never reaches the host's event stream.
 */
import '../fixtures/test-host.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../src/kernel/types.ts';
import type { TraceRecord } from '../../src/observability/trace-record.ts';
import { catalogedSink, catalogGate } from '../fixtures/trace-catalog.ts';

const IDENTITY = { id: 'gen-1', model: 'vendor/model-a' };

/** Run one chat turn on `provider`; the host's events and the call span's identity attributes. */
async function traced(
  provider: ModelProvider,
): Promise<{ events: TurnEvent[]; id: unknown; model: unknown }> {
  const into: TraceRecord[] = [];
  const events: TurnEvent[] = [];
  for await (const event of runTurn(
    { profile: 'chat', input: { text: 'hi' } },
    provider,
    catalogedSink(into),
  )) {
    events.push(event);
  }
  const call = into[0]?.spans.find((span) => span.kind === 'CLIENT');
  return {
    events,
    id: call?.attributes['gen_ai.response.id'],
    model: call?.attributes['gen_ai.response.model'],
  };
}

Deno.test('a call cut by a canary leak still records which model served it', async () => {
  const provider: ModelProvider = {
    async *complete(req: ProviderCompleteRequest) {
      await Promise.resolve();
      const canary = /This turn's canary is (\S+)\./.exec(req.system ?? '')?.[1] ?? '';
      yield { type: 'response', response: IDENTITY };
      yield { type: 'text', text: `leaking ${canary}` };
      yield { type: 'text', text: 'never reached' };
    },
  };
  const { events, id, model } = await traced(provider);
  assertEquals(events.find((e) => e.type === 'error')?.errorInternal, 'canary leaked');
  assertEquals(
    events.some((e) => e.type === 'response'),
    false,
  );
  assertEquals([id, model], [IDENTITY.id, IDENTITY.model]);
});

Deno.test('a call that fails after the wire named it still records which model served it', async () => {
  const provider: ModelProvider = {
    async *complete() {
      await Promise.resolve();
      yield { type: 'response', response: IDENTITY };
      yield { type: 'text', text: 'not json' };
      yield { type: 'error', error: 'structured output was not valid JSON' };
    },
  };
  const { events, id, model } = await traced(provider);
  assertEquals(
    events.some((e) => e.type === 'response'),
    false,
  );
  assertEquals([id, model], [IDENTITY.id, IDENTITY.model]);
});

catalogGate();
