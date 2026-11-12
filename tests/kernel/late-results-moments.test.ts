/**
 * A turn asks its `lateResults` source at three moments: as it opens, after each step whose
 * calls settled, and once the model has answered. What lands is one message the model reads on its
 * next step, and a history built from the turn's events holds it where the turn did.
 */

import { createTestKernelScope } from '../fixtures/provider-scope.ts';
import { runScopedTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { z } from 'zod';
import type { HostFind } from '../../src/guardrails/detectors.ts';
import { isLateResult } from '../../src/guardrails/tool-fence.ts';
import { foldConversationTurn } from '../../src/interface/blocks.ts';
import {
  appendAssistantEventsToHistory,
  historyFromTranscriptBlocks,
} from '../../src/interface/history.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { KernelScope } from '../../src/kernel/scope.ts';
import type { ToolOperationOutcome } from '../../src/kernel/tools/operation.ts';
import type {
  LateResultsMoment,
  LateResultsSource,
  ModelEvent,
  ModelRequest,
  TurnEvent,
  TurnHistoryMessage,
  TurnModel,
  TurnRequest,
} from '../../src/kernel/types.ts';
import { eventsOf } from '../fixtures/events.ts';
import { geminiModels } from '../fixtures/models.ts';

const FINDING = 'The shop on Elm Street has it in stock.';

interface Setup {
  maxSteps?: number;
  allowSteering?: boolean;
  /** A reply this matches is blocked, and the turn asks the model again. */
  blockReply?: HostFind;
}

function scopeFor(id: string, setup: Setup = {}): KernelScope {
  const scope = createTestKernelScope();
  scope.tools.register({
    type: 'function',
    name: 'lookup',
    description: 'Look something up.',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({ what: z.string() }),
    output: z.object({ found: z.string() }),
    handler: ({ what }) => ({ found: `found ${what}` }),
  });
  scope.tools.register({
    type: 'function',
    name: 'place_order',
    description: 'Place an order.',
    category: 'test',
    access: 'destructive',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'always_confirm',
    input: z.object({}),
    output: z.object({ placed: z.boolean() }),
    handler: () => ({ placed: true }),
  });
  scope.profiles.register({
    ...defineProfile({
      type: 'text',
      id,
      identity: { handle: id },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: setup.maxSteps ?? 4,
      tools: { allow: ['lookup', 'place_order'], parallel: true },
      inputs: { text: true },
      outputs: {},
      ...(setup.blockReply
        ? {
            guardrails: {
              blockedReply: { onBlock: 'retry', maxRetries: 1 },
              detect: {
                'test.own': { label: 'Test', at: { reply: 'block' }, find: setup.blockReply },
              },
            },
          }
        : {}),
    }),
    ...(setup.allowSteering === false ? { turnBehaviour: { allowSteering: false } } : {}),
  });
  return scope;
}

/** The outcome of a call that ended after the turn that started it. */
function lateResult(operationId = 'late-op', finding = FINDING): ToolOperationOutcome {
  return {
    event: {
      type: 'tool',
      tool: {
        phase: 'complete',
        name: 'find_stores',
        callId: `call-${operationId}`,
        operationId,
        output: { finding },
        readBack: finding,
        at: 0,
      },
    },
    effects: 'completed',
    replay: { modelResult: { finding } },
  };
}

/** A source that gives `outcomes` at `when`, and records every moment it was asked. */
function sourceAt(
  when: (moment: LateResultsMoment) => boolean,
  outcomes: readonly ToolOperationOutcome[] = [lateResult()],
): { source: LateResultsSource; asked: Pick<LateResultsMoment, 'stage' | 'step'>[] } {
  const asked: Pick<LateResultsMoment, 'stage' | 'step'>[] = [];
  return {
    asked,
    source: (moment) => {
      asked.push({ stage: moment.stage, step: moment.step });
      return when(moment) ? outcomes : [];
    },
  };
}

/** A model that runs `steps` in order, one per model call, and answers once they run out. */
function scripted(steps: ModelEvent[][], requests: ModelRequest[]): TurnModel {
  let index = 0;
  return {
    async *complete(request) {
      await Promise.resolve();
      requests.push(request);
      const step = steps[index] ?? [{ type: 'text', text: `answer ${index}` }];
      index += 1;
      yield* step;
    },
  };
}

function lookup(what: string): ModelEvent {
  return { type: 'tool', tool: { name: 'lookup', callId: `c-${what}`, arguments: { what } } };
}

async function run(
  scope: KernelScope,
  id: string,
  source: LateResultsSource,
  model: TurnModel,
  onStage?: TurnRequest['onStage'],
): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  const request: TurnRequest = {
    profile: id,
    input: { text: 'Any plant shops near me?' },
    lateResults: source,
    ...(onStage ? { onStage } : {}),
  };
  for await (const event of runScopedTurn(scope, request, model)) events.push(event);
  return events;
}

/** The history a host builds from the turn's events. */
function builtFrom(events: readonly TurnEvent[]): TurnHistoryMessage[] {
  return appendAssistantEventsToHistory(
    [{ role: 'user', content: 'Any plant shops near me?' }],
    events,
  );
}

const lateOf = (events: readonly TurnEvent[]) => eventsOf(events, 'late_results');

Deno.test('a result that ends during a step lands once, after all of the step’s calls', async () => {
  const id = 'late_after_step';
  const scope = scopeFor(id);
  const { source, asked } = sourceAt(({ stage, step }) => stage === 'post_tool' && step === 1);
  const requests: ModelRequest[] = [];
  const events = await run(scope, id, source, scripted([[lookup('a'), lookup('b')]], requests));

  const late = lateOf(events);
  assertEquals(late.length, 1);
  assertEquals(
    [late[0]?.stage, late[0]?.step, late[0]?.operationIds],
    ['post_tool', 1, ['late-op']],
  );
  const lateAt = events.findIndex((event) => event.type === 'late_results');
  const lastCall = events.findLastIndex(
    (event) => event.type === 'tool' && event.tool.phase === 'complete',
  );
  assertEquals(lastCall < lateAt, true);

  const read = requests[1]?.history ?? [];
  const roles = read.slice(-4).map((message) => message.role);
  assertEquals(roles, ['assistant', 'tool', 'tool', 'user']);
  assertEquals(isLateResult(read.at(-1) ?? { role: 'user', content: '' }), true);
  assertEquals(read.at(-1)?.content?.includes(FINDING), true);
  // The model reads the person's words in a fence; everything after them is as the host built it.
  assertEquals(builtFrom(events).slice(1, read.length), read.slice(1));
  assertEquals(asked, [
    { stage: 'pre_turn', step: 0 },
    { stage: 'post_tool', step: 1 },
    { stage: 'before_end', step: 2 },
  ]);
});

Deno.test('a result given at the opening and again mid-turn lands once', async () => {
  const id = 'late_open_and_step';
  const scope = scopeFor(id);
  const { source } = sourceAt(() => true);
  const requests: ModelRequest[] = [];
  const events = await run(scope, id, source, scripted([[lookup('a')]], requests));

  assertEquals(
    lateOf(events).map((event) => event.stage),
    ['pre_turn'],
  );
  assertEquals(builtFrom(events).filter(isLateResult).length, 1);
  assertEquals((requests.at(-1)?.history ?? []).filter(isLateResult).length, 1);
});

Deno.test('two results given in one batch under one id land as one', async () => {
  const id = 'late_batch_dup';
  const scope = scopeFor(id);
  const { source } = sourceAt(({ stage }) => stage === 'post_tool', [lateResult(), lateResult()]);
  const events = await run(scope, id, source, scripted([[lookup('a')]], []));
  assertEquals(
    lateOf(events).map((event) => event.operationIds),
    [['late-op']],
  );
});

Deno.test('a result that ends once the model has answered is read before the turn ends', async () => {
  const id = 'late_before_end';
  const scope = scopeFor(id);
  const { source, asked } = sourceAt(({ stage }) => stage === 'before_end');
  const requests: ModelRequest[] = [];
  const model = scripted([[{ type: 'text', text: 'Let me look.' }]], requests);
  const events = await run(scope, id, source, model);

  assertEquals(
    lateOf(events).map((event) => [event.stage, event.step]),
    [['before_end', 1]],
  );
  assertEquals(requests.length, 2);
  const read = requests[1]?.history ?? [];
  assertEquals(read.at(-2), { role: 'assistant', content: 'Let me look.' });
  assertEquals(isLateResult(read.at(-1) ?? { role: 'user', content: '' }), true);
  // The model reads the person's words in a fence; everything after them is as the host built it.
  assertEquals(builtFrom(events).slice(1, read.length), read.slice(1));
  assertEquals(
    asked.map((moment) => moment.stage),
    ['pre_turn', 'before_end', 'before_end'],
  );
});

Deno.test('mid-turn, nothing is asked when the profile takes no steering', async () => {
  const id = 'late_no_steering';
  const scope = scopeFor(id, { allowSteering: false });
  const { source, asked } = sourceAt(() => true);
  const events = await run(scope, id, source, scripted([[lookup('a')]], []));
  assertEquals(asked, [{ stage: 'pre_turn', step: 0 }]);
  assertEquals(
    lateOf(events).map((event) => event.stage),
    ['pre_turn'],
  );
});

Deno.test('mid-turn, nothing is asked when another step would pass maxSteps', async () => {
  const id = 'late_max_steps';
  const scope = scopeFor(id, { maxSteps: 1 });
  const { source, asked } = sourceAt(({ stage }) => stage !== 'pre_turn');
  const events = await run(scope, id, source, scripted([[{ type: 'text', text: 'Done.' }]], []));
  assertEquals(asked, [{ stage: 'pre_turn', step: 0 }]);
  assertEquals(lateOf(events), []);
});

Deno.test('a result not asked for at one moment lands at the next one that can take it', async () => {
  const id = 'late_later';
  const scope = scopeFor(id, { maxSteps: 3 });
  let ready = false;
  const asked: Pick<LateResultsMoment, 'stage' | 'step'>[] = [];
  const source: LateResultsSource = ({ stage, step }) => {
    asked.push({ stage, step });
    if (stage === 'post_tool' && step === 1) ready = true;
    return ready && step >= 2 ? [lateResult()] : [];
  };
  const events = await run(scope, id, source, scripted([[lookup('a')], [lookup('b')]], []));
  assertEquals(
    lateOf(events).map((event) => [event.stage, event.step]),
    [['post_tool', 2]],
  );
  assertEquals(builtFrom(events).filter(isLateResult).length, 1);
});

Deno.test('a source that throws is reported, and the turn goes on', async () => {
  const id = 'late_throws';
  const scope = scopeFor(id);
  const source: LateResultsSource = ({ stage }) => {
    if (stage === 'post_tool') throw new Error('inbox down');
    return [];
  };
  const events = await run(scope, id, source, scripted([[lookup('a')]], []));
  const failed = eventsOf(events, 'hook_failed');
  assertEquals(
    failed.map((event) => [event.hook, event.stage]),
    [['lateResults', 'post_tool']],
  );
  assertEquals(
    eventsOf(events, 'text')
      .map((event) => event.text)
      .join(''),
    'answer 1',
  );
});

Deno.test('a result read before a retry stays one message the retry reads', async () => {
  const id = 'late_retry';
  const scope = scopeFor(id, {
    blockReply: (text) => (text.includes('BAD') ? [{ start: 0, end: text.length }] : []),
  });
  const { source } = sourceAt(({ stage }) => stage === 'post_tool');
  const requests: ModelRequest[] = [];
  const model = scripted(
    [[lookup('a')], [{ type: 'text', text: 'BAD' }], [{ type: 'text', text: 'Elm Street.' }]],
    requests,
  );
  const events = await run(scope, id, source, model);

  assertEquals(eventsOf(events, 'attempt').length, 1);
  assertEquals(lateOf(events).length, 1);
  assertEquals((requests.at(-1)?.history ?? []).filter(isLateResult).length, 1);
  assertEquals(builtFrom(events).filter(isLateResult).length, 1);
});

Deno.test('a result that lands after a reply the guard held is read after all of that reply', async () => {
  const id = 'late_before_end_held';
  const scope = scopeFor(id, { blockReply: () => [] });
  const { source } = sourceAt(({ stage }) => stage === 'before_end');
  const requests: ModelRequest[] = [];
  const long = `${'The shop on Elm Street opens at nine and closes at six. '.repeat(20)}Done.`;
  const model = scripted([[{ type: 'text', text: long }]], requests);
  const events = await run(scope, id, source, model);

  assertEquals(lateOf(events).length, 1);
  const read = requests[1]?.history ?? [];
  assertEquals(read.at(-2), { role: 'assistant', content: long });
  // The model reads the person's words in a fence; everything after them is as the host built it.
  assertEquals(builtFrom(events).slice(1, read.length), read.slice(1));
});

Deno.test('a result that lands after a reply is read once when the next reply is retried', async () => {
  const id = 'late_before_end_retry';
  const scope = scopeFor(id, {
    blockReply: (text) => (text.includes('BAD') ? [{ start: 0, end: text.length }] : []),
  });
  let given = false;
  const source: LateResultsSource = ({ stage }) => {
    if (stage !== 'before_end' || given) return [];
    given = true;
    return [lateResult()];
  };
  const requests: ModelRequest[] = [];
  const model = scripted(
    [
      [{ type: 'text', text: 'Let me look.' }],
      [{ type: 'text', text: 'BAD' }],
      [{ type: 'text', text: 'Elm Street.' }],
    ],
    requests,
  );
  const events = await run(scope, id, source, model);

  assertEquals(eventsOf(events, 'attempt').length, 1);
  assertEquals((requests.at(-1)?.history ?? []).filter(isLateResult).length, 1);
  // The host keeps the late result and the answer that passed; the rejected draft is gone.
  const built = builtFrom(events);
  assertEquals(
    built.slice(1).map((message) => [message.role, isLateResult(message), message.content]),
    [
      ['user', true, built[1]?.content],
      ['assistant', false, 'Elm Street.'],
    ],
  );
});

const opening = [{ stage: 'pre_turn', step: 0 }];

Deno.test('mid-turn, nothing is asked after a step held for approval', async () => {
  const id = 'late_gated';
  const scope = scopeFor(id);
  const { source, asked } = sourceAt(() => true, []);
  const order: ModelEvent = {
    type: 'tool',
    tool: { name: 'place_order', callId: 'c-order', arguments: {} },
  };
  const events = await run(scope, id, source, scripted([[order]], []));
  assertEquals(eventsOf(events, 'tool').at(-1)?.tool.phase, 'gate');
  assertEquals(asked, opening);
});

Deno.test('mid-turn, nothing is asked after a step a stage ended', async () => {
  const id = 'late_ended';
  const scope = scopeFor(id);
  const { source, asked } = sourceAt(() => true, []);
  const events = await run(scope, id, source, scripted([[lookup('a')]], []), ({ stage }) =>
    stage === 'post_tool' ? { end: true } : undefined,
  );
  assertEquals(eventsOf(events, 'done').at(-1)?.stop?.kind, 'completed');
  assertEquals(asked, opening);
});

Deno.test('mid-turn, nothing is asked after a step a stage stopped', async () => {
  const id = 'late_stopped';
  const scope = scopeFor(id);
  const { source, asked } = sourceAt(() => true, []);
  const events = await run(scope, id, source, scripted([[lookup('a')]], []), ({ stage }) =>
    stage === 'post_tool' ? { abort: true } : undefined,
  );
  assertEquals(eventsOf(events, 'done').at(-1)?.stop?.kind, 'cancelled');
  assertEquals(asked, opening);
});

Deno.test('nothing is asked once the model has answered when before_end stops the turn', async () => {
  const id = 'late_before_end_abort';
  const scope = scopeFor(id);
  const { source, asked } = sourceAt(() => true, []);
  const model = scripted([[{ type: 'text', text: 'Done.' }]], []);
  const events = await run(scope, id, source, model, ({ stage }) =>
    stage === 'before_end' ? { abort: true } : undefined,
  );
  assertEquals(eventsOf(events, 'done').at(-1)?.stop?.kind, 'cancelled');
  assertEquals(asked, opening);
});

Deno.test('mid-turn, nothing is asked after calls on the last step the turn allows', async () => {
  const id = 'late_last_step';
  const scope = scopeFor(id, { maxSteps: 1 });
  const { source, asked } = sourceAt(() => true, []);
  const events = await run(scope, id, source, scripted([[lookup('a')]], []));
  assertEquals(eventsOf(events, 'done').at(-1)?.stop?.kind, 'step_limit');
  assertEquals(asked, opening);
});

Deno.test('a transcript keeps a result that landed mid-turn where the turn read it', async () => {
  const id = 'late_blocks';
  const scope = scopeFor(id);
  const { source } = sourceAt(({ stage, step }) => stage === 'post_tool' && step === 1);
  const requests: ModelRequest[] = [];
  const events = await run(scope, id, source, scripted([[lookup('a')]], requests));
  const read = requests[1]?.history ?? [];
  const rebuilt = historyFromTranscriptBlocks(
    foldConversationTurn({ text: 'Any plant shops near me?' }, events),
  );
  assertEquals(rebuilt.slice(1, read.length), read.slice(1));
  assertEquals(read.at(-1)?.metadata?.lateResultsInReply, true);
});

Deno.test('a steer before a retry reads as a result does: the retry reads the draft before it', async () => {
  const id = 'steer_before_end_retry';
  const scope = scopeFor(id, {
    blockReply: (text) => (text.includes('BAD') ? [{ start: 0, end: text.length }] : []),
  });
  let steered = false;
  const requests: ModelRequest[] = [];
  const model = scripted(
    [
      [{ type: 'text', text: 'Let me look.' }],
      [{ type: 'text', text: 'BAD' }],
      [{ type: 'text', text: 'Elm Street.' }],
    ],
    requests,
  );
  await run(
    scope,
    id,
    () => [],
    model,
    ({ stage }) => {
      if (stage !== 'before_end' || steered) return;
      steered = true;
      return { inject: [{ role: 'user', content: 'and the fern?' }] };
    },
  );
  const retry = requests.at(-1)?.history ?? [];
  assertEquals(
    retry.some((message) => message.role === 'assistant' && message.content === 'Let me look.'),
    true,
  );
});
