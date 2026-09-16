/**
 * Turn-stage spine: pre_turn / post_tool / before_end / post_turn + onStage inject.
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

function stageNames(events: TurnEvent[]): string[] {
  return events.filter((e) => e.type === 'stage' && !e.stageWarnings).map((e) => e.stage ?? '');
}

Deno.test('stages: emits pre_turn / before_end / post_turn on a plain text turn', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'stage.spine.basic',
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
    runTurn({ profile: 'stage.spine.basic', input: { text: 'hi' } }, provider),
  );
  assertEquals(stageNames(events), ['pre_turn', 'before_end', 'post_turn']);
  assertEquals(
    events.some((e) => e.type === 'done'),
    true,
  );
});

Deno.test('stages: allowSteering false still emits stages but rejects inject', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'stage.spine.off',
      identity: { handle: 'bot' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [] },
      inputs: { text: true },
      turnBehaviour: { allowSteering: false },
    }),
  );

  let staged = 0;
  let seenHistory: TurnHistoryMessage[] | undefined;
  const provider: ModelProvider = {
    complete: async function* (req: ProviderCompleteRequest) {
      seenHistory = req.history;
      yield { type: 'text', text: 'ok' };
      yield { type: 'done' };
    },
  };

  const events = await collect(
    runTurn(
      {
        profile: 'stage.spine.off',
        input: { text: 'hi' },
        onStage: ({ stage }) => {
          staged++;
          if (stage === 'pre_turn') {
            return { inject: [{ role: 'user', content: 'should not land' }] };
          }
        },
      },
      provider,
    ),
  );
  assertEquals(stageNames(events), ['pre_turn', 'before_end', 'post_turn']);
  assertEquals(staged >= 3, true);
  assertEquals(
    seenHistory?.some((m) => m.content === 'should not land'),
    false,
  );
});

Deno.test('stages: onStage inject at pre_turn reaches the provider history', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'stage.inject.pre_turn',
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
        profile: 'stage.inject.pre_turn',
        input: { text: 'first' },
        onStage: ({ stage }) => {
          if (stage === 'pre_turn') {
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

Deno.test('stages: post_tool inject after tools before next model step', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'stage.inject.post_tool',
      identity: { handle: 'bot' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 3,
      tools: { allow: ['stub_tool'] },
      inputs: { text: true },
    }),
  );

  const stages: string[] = [];
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
        profile: 'stage.inject.post_tool',
        input: { text: 'run tool' },
        onStage: ({ stage, history }) => {
          stages.push(stage);
          if (stage === 'post_tool') {
            return {
              inject: [{ role: 'user', content: 'also do this' }],
            };
          }
          if (stage === 'pre_turn') {
            assertStringIncludes(history.map((m) => m.content).join('|'), 'run tool');
          }
        },
      },
      provider,
    ),
  );

  assertEquals(stages.includes('pre_turn'), true);
  assertEquals(stages.includes('post_tool'), true);
  assertEquals(stages.includes('before_end'), true);
  assertEquals(stages.includes('post_turn'), true);
  assertEquals(
    events.filter((e) => e.type === 'stage').map((e) => e.stage),
    stageNames(events),
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

Deno.test('stages: before_end inject re-enters the model step under maxSteps', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'stage.before_end.extend',
      identity: { handle: 'bot' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 2,
      tools: { allow: [] },
      inputs: { text: true },
    }),
  );

  let call = 0;
  const provider: ModelProvider = {
    complete: async function* (req: ProviderCompleteRequest) {
      call++;
      if (call === 1) {
        assertEquals(
          req.history?.some((m) => m.content === 'extend please'),
          false,
        );
        yield { type: 'text', text: 'first reply' };
        yield { type: 'done' };
        return;
      }
      assertEquals(
        req.history?.some((m) => m.content === 'extend please'),
        true,
      );
      yield { type: 'text', text: 'second reply' };
      yield { type: 'done' };
    },
  };

  let beforeEndCount = 0;
  const events = await collect(
    runTurn(
      {
        profile: 'stage.before_end.extend',
        input: { text: 'hi' },
        onStage: ({ stage }) => {
          if (stage === 'before_end') {
            beforeEndCount++;
            if (beforeEndCount === 1) {
              return { inject: [{ role: 'user', content: 'extend please' }] };
            }
          }
        },
      },
      provider,
    ),
  );

  assertEquals(call, 2);
  assertEquals(beforeEndCount >= 2, true);
  assertEquals(
    events.some((e) => e.type === 'text' && e.text === 'second reply'),
    true,
  );
});

Deno.test('stages: before_end inject cannot exceed maxSteps across re-entry', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'stage.before_end.maxsteps',
      identity: { handle: 'bot' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [] },
      inputs: { text: true },
    }),
  );

  let call = 0;
  const provider: ModelProvider = {
    complete: async function* () {
      call++;
      yield { type: 'text', text: `reply-${call}` };
      yield { type: 'done' };
    },
  };

  const events = await collect(
    runTurn(
      {
        profile: 'stage.before_end.maxsteps',
        input: { text: 'hi' },
        onStage: ({ stage }) => {
          if (stage === 'before_end') {
            return { inject: [{ role: 'user', content: 'should not extend' }] };
          }
        },
      },
      provider,
    ),
  );

  assertEquals(call, 1);
  assertEquals(
    events.some(
      (e) =>
        e.type === 'stage' && e.stageWarnings?.some((w) => w.code === 'inject_rejected_max_steps'),
    ),
    true,
  );
});

Deno.test('stages: inject_not_allowed yields stageWarnings', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'stage.warn.inject_off',
      identity: { handle: 'bot' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [] },
      inputs: { text: true },
      turnBehaviour: { allowSteering: false },
    }),
  );

  const provider: ModelProvider = {
    complete: async function* () {
      yield { type: 'text', text: 'ok' };
      yield { type: 'done' };
    },
  };

  const events = await collect(
    runTurn(
      {
        profile: 'stage.warn.inject_off',
        input: { text: 'hi' },
        onStage: ({ stage }) => {
          if (stage === 'pre_turn') {
            return { inject: [{ role: 'user', content: 'nope' }] };
          }
        },
      },
      provider,
    ),
  );

  assertEquals(
    events.some(
      (e) => e.type === 'stage' && e.stageWarnings?.some((w) => w.code === 'inject_not_allowed'),
    ),
    true,
  );
});
