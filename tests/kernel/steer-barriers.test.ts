/**
 * Mid-turn steering barriers: pre_llm / pre_tool_followup + onSteer inject.
 */
import '../fixtures/test-host.ts';
import { assertEquals, assertStringIncludes } from '../../src/kernel/engine/assert.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import { defineProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import type {
  ModelProvider,
  ProviderCompleteRequest,
  TurnEvent,
  TurnHistoryMessage,
} from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

Deno.test('steer: emits pre_llm barrier when allowSteering (default)', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'steer.barrier.basic',
      identity: { handle: 'bot' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [] },
      inputs: { text: true },
    }),
  );

  const provider: ModelProvider = {
    complete: async function* () {
      yield { type: 'text', text: 'ok' };
      yield { type: 'done' };
    },
  };

  const events = await collect(
    runTurn({ profile: 'steer.barrier.basic', input: { text: 'hi' } }, provider),
  );
  assertEquals(
    events.filter((e) => e.type === 'barrier').map((e) => e.barrier),
    ['pre_llm'],
  );
});

Deno.test('steer: allowSteering false skips barriers and onSteer', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'steer.barrier.off',
      identity: { handle: 'bot' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [] },
      inputs: { text: true },
      turnBehaviour: { allowSteering: false },
    }),
  );

  let steered = 0;
  const provider: ModelProvider = {
    complete: async function* () {
      yield { type: 'text', text: 'ok' };
      yield { type: 'done' };
    },
  };

  const events = await collect(
    runTurn(
      {
        profile: 'steer.barrier.off',
        input: { text: 'hi' },
        onSteer: () => {
          steered++;
          return { inject: [{ role: 'user', content: 'should not land' }] };
        },
      },
      provider,
    ),
  );
  assertEquals(
    events.some((e) => e.type === 'barrier'),
    false,
  );
  assertEquals(steered, 0);
});

Deno.test('steer: onSteer inject at pre_llm reaches the provider history', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'steer.inject.pre_llm',
      identity: { handle: 'bot' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [] },
      inputs: { text: true },
    }),
  );

  let seenHistory: TurnHistoryMessage[] | undefined;
  const provider: ModelProvider = {
    complete: async function* (req: ProviderCompleteRequest) {
      seenHistory = req.history;
      yield { type: 'text', text: 'acked' };
      yield { type: 'done' };
    },
  };

  await collect(
    runTurn(
      {
        profile: 'steer.inject.pre_llm',
        input: { text: 'first' },
        onSteer: ({ barrier }) => {
          if (barrier === 'pre_llm') {
            return { inject: [{ role: 'user', content: 'follow-up absorbed' }] };
          }
        },
      },
      provider,
    ),
  );

  assertEquals(
    seenHistory?.some((m) => m.content === 'follow-up absorbed'),
    true,
  );
  assertEquals(
    seenHistory?.some((m) => typeof m.content === 'string' && m.content.includes('first')),
    true,
  );
});

Deno.test('steer: pre_tool_followup inject after tools before next model step', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'steer.inject.pre_tool_followup',
      identity: { handle: 'bot' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 3,
      tools: { allow: ['stub_tool'] },
      inputs: { text: true },
    }),
  );

  const barriers: string[] = [];
  let call = 0;
  let secondInteractionInput: Record<string, unknown>[] | undefined;
  const provider: ModelProvider = {
    complete: async function* (req: ProviderCompleteRequest) {
      call++;
      if (call === 1) {
        yield {
          type: 'tool',
          tool: { name: 'stub_tool', arguments: { value: 1 }, id: 'c1' },
        };
        yield { type: 'done', interactionId: 'ix-1' };
        return;
      }
      secondInteractionInput = req.interactionOnlyInput;
      yield { type: 'text', text: 'after tools' };
      yield { type: 'done' };
    },
  };

  const events = await collect(
    runTurn(
      {
        profile: 'steer.inject.pre_tool_followup',
        input: { text: 'run tool' },
        onSteer: ({ barrier, history }) => {
          barriers.push(barrier);
          if (barrier === 'pre_tool_followup') {
            return {
              inject: [{ role: 'user', content: 'also do this' }],
            };
          }
          assertStringIncludes(history.map((m) => m.content).join('|'), 'run tool');
        },
      },
      provider,
    ),
  );

  assertEquals(barriers, ['pre_llm', 'pre_tool_followup']);
  assertEquals(
    events.filter((e) => e.type === 'barrier').map((e) => e.barrier),
    ['pre_llm', 'pre_tool_followup'],
  );
  assertEquals(call, 2);
  assertEquals(
    events.some((e) => e.type === 'text' && e.text === 'after tools'),
    true,
  );
  const wire = JSON.stringify(secondInteractionInput ?? []);
  assertStringIncludes(wire, 'function_result');
  assertStringIncludes(wire, 'also do this');
  assertStringIncludes(wire, 'user_input');
});
