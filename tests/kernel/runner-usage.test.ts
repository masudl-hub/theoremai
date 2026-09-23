import '../fixtures/test-host.ts';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import { defineProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import type { ModelProvider, TurnEvent, TurnTokens } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

function registerToolProfile(id: string): string {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id,
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 3,
      tools: { allow: ['fetch_sensor'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 100 } },
    }),
  );
  return id;
}

/** Provider answering each call from `calls`, in order. */
function scriptedProvider(calls: TurnEvent[][]): ModelProvider {
  let call = 0;
  return {
    async *complete() {
      await Promise.resolve();
      for (const event of calls[call++] ?? []) yield event;
    },
  };
}

async function collect(profile: string, provider: ModelProvider): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const event of runTurn({ profile, input: { text: 'Check soil' } }, provider)) {
    events.push(event);
  }
  return events;
}

function tokensOf(events: TurnEvent[]): TurnTokens[] {
  return events.flatMap((e) => (e.type === 'tokens' && e.tokens ? [e.tokens] : []));
}

const SENSOR_CALL: TurnEvent = {
  type: 'tool',
  tool: { name: 'fetch_sensor', arguments: { sensor: 'soil' }, id: 'call_1' },
};

Deno.test('runTurn emits one tokens event per model call, after that call', async () => {
  const first: TurnTokens = { input: 120, output: 30, thinking: 20, total: 150 };
  const second: TurnTokens = { input: 180, output: 12, total: 192 };
  const profile = registerToolProfile('usage_per_call');
  const events = await collect(
    profile,
    scriptedProvider([
      [
        { type: 'tokens', tokens: { input: 1, output: 1, total: 2 } },
        { type: 'tokens', tokens: first, interactionId: 'v1_a' },
        SENSOR_CALL,
      ],
      [
        { type: 'text', text: 'Soil reads 22%.' },
        { type: 'tokens', tokens: second },
      ],
    ]),
  );
  // Last report per call wins; reasoning the provider did not stream still counts.
  assertEquals(tokensOf(events), [first, second]);
  const types = events.map((e) => e.type);
  assertEquals(types.indexOf('tokens') < types.indexOf('text'), true);
  assertEquals(types.lastIndexOf('tokens') > types.indexOf('text'), true);
});

Deno.test('runTurn estimates a call the provider reported no usage for', async () => {
  const profile = registerToolProfile('usage_estimated');
  const events = await collect(
    profile,
    scriptedProvider([[{ type: 'text', text: 'hello world' }]]),
  );
  const [tokens] = tokensOf(events);
  assertEquals(tokens?.estimated, ['input', 'output']);
  assertEquals(tokens?.output, encode('hello world').length);
  assertEquals((tokens?.input ?? 0) > encode('Check soil').length, true);
  assertEquals(tokens?.total, (tokens?.input ?? 0) + (tokens?.output ?? 0));
  assertEquals(tokens?.unknownMedia, undefined);
});

Deno.test('runTurn keeps the reported side and estimates only the missing one', async () => {
  const profile = registerToolProfile('usage_partial');
  const events = await collect(
    profile,
    scriptedProvider([
      [
        { type: 'text', text: 'hello world' },
        {
          type: 'tokens',
          tokens: { input: 0, output: 9, total: 9, estimated: ['input'], cost: { usd: 0.002 } },
        },
      ],
    ]),
  );
  const [tokens] = tokensOf(events);
  assertEquals(tokens?.output, 9);
  assertEquals(tokens?.estimated, ['input']);
  assertEquals(tokens?.cost, { usd: 0.002 });
  assertEquals((tokens?.input ?? 0) > 0, true);
  assertEquals(tokens?.total, (tokens?.input ?? 0) + 9);
});

Deno.test('runTurn emits no tokens for a call that failed with no usage', async () => {
  const profile = registerToolProfile('usage_failed');
  const events = await collect(
    profile,
    scriptedProvider([[{ type: 'error', error: 'upstream failed' }]]),
  );
  assertEquals(tokensOf(events), []);
});

const stopOf = (events: TurnEvent[]) => events.findLast((e) => e.type === 'done')?.stop;

Deno.test('runTurn ends a call the provider failed as provider_error, even after its done', async () => {
  const profile = registerToolProfile('stop_provider_error');
  const failed = await collect(
    profile,
    scriptedProvider([[{ type: 'error', error: 'upstream failed' }]]),
  );
  assertEquals(stopOf(failed), { kind: 'provider_error' });

  const failedThenDone = await collect(
    profile,
    scriptedProvider([
      [
        { type: 'error', error: 'row was not JSON' },
        { type: 'done', stop: { kind: 'completed', native: 'completed' } },
      ],
    ]),
  );
  assertEquals(stopOf(failedThenDone), { kind: 'provider_error' });
});

Deno.test('runTurn estimates an Interactions continuation from the logical prompt', async () => {
  const profile = registerToolProfile('usage_continuation');
  let requests = 0;
  const calls: TurnEvent[][] = [
    [{ ...SENSOR_CALL, interactionId: 'v1_sensor' }],
    [{ type: 'text', text: 'Soil reads 22%.' }],
  ];
  const provider: ModelProvider = {
    async *complete(req) {
      await Promise.resolve();
      if (requests === 1) assertEquals(req.previousInteractionId, 'v1_sensor');
      for (const event of calls[requests++] ?? []) yield event;
    },
  };
  const events = await collect(profile, provider);
  const [first, second] = tokensOf(events);
  assertEquals(first?.output, encode('fetch_sensor').length + encode('{"sensor":"soil"}').length);
  // The continuation sends only the function result, but the model reads the stored
  // interaction too: the first prompt, the replayed tool call, then the result.
  const firstPrompt = first?.input ?? 0;
  const replayedCall = first?.output ?? 0;
  assertEquals((second?.input ?? 0) > firstPrompt + replayedCall, true);
});
