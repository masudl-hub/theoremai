import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { assert, assertEquals } from '@std/assert';
import { z } from 'zod';
import { ANSWER_TOOL } from '../../src/kernel/answer-tool.ts';
import { registerProfile, registerTool } from '../../src/kernel/default-scope.ts';
import type { StageContext, StageResult } from '../../src/kernel/stages.ts';
import { applyStageResult } from '../../src/kernel/stages.ts';
import { keptReply } from '../../src/kernel/turn-events.ts';
import type { ModelEvent, TurnEvent, TurnModel, TurnStage } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';
import { replyText } from '../fixtures/reply.ts';

const PICK = 'end_test_pick';
const NOTE = 'end_test_note';
const ONE_AT_A_TIME = 'end_test_caller';
const SIDE_BY_SIDE = 'end_test_parallel';
const ANSWERS = 'end_test_answers';
const ANSWERS_WITH_REPAIR = 'end_test_answers_repair';

for (const name of [PICK, NOTE]) {
  registerTool({
    type: 'function',
    name,
    description: 'Records a choice.',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({ val: z.number() }),
    output: z.object({ finding: z.string() }),
    handler: () => ({ finding: 'recorded' }),
  });
}
for (const [id, parallel] of [
  [ONE_AT_A_TIME, false],
  [SIDE_BY_SIDE, true],
] as const) {
  registerProfile({
    type: 'text',
    id,
    identity: { handle: id },
    ...geminiModels('gemini35FlashLite'),
    maxSteps: 4,
    tools: { allow: [PICK, NOTE], parallel },
    inputs: { text: true },
    outputs: {},
    guardrails: { quota: { perDay: 500 } },
  });
}

for (const [id, validation] of [
  [ANSWERS, undefined],
  [ANSWERS_WITH_REPAIR, { maxRetries: 1 }],
] as const) {
  registerProfile({
    type: 'text',
    id,
    identity: { handle: id },
    ...geminiModels('gemini35FlashLite'),
    maxSteps: 4,
    tools: { allow: ['fetch_sensor'] },
    inputs: { text: true },
    outputs: { structured: 'chatTurn', ...(validation ? { validation } : {}) },
    guardrails: { quota: { perDay: 500 } },
  });
}

/** A model that writes, calls `calls` in one step, and would write again if asked. */
function writer(calls: readonly string[]): { model: TurnModel; steps: () => number } {
  let step = 0;
  return {
    steps: () => step,
    model: {
      async *complete() {
        await Promise.resolve();
        step += 1;
        if (step === 1) {
          yield { type: 'text', text: 'Your fern needs water.' };
          for (const [index, name] of calls.entries()) {
            yield { type: 'tool', tool: { name, arguments: { val: 1 }, callId: `c${index}` } };
          }
          return;
        }
        yield { type: 'text', text: ' Anything else?' };
      },
    },
  };
}

/** A model that answers each call with the next script. */
function scripted(scripts: readonly ModelEvent[][]): { model: TurnModel; steps: () => number } {
  let step = 0;
  return {
    steps: () => step,
    model: {
      async *complete() {
        await Promise.resolve();
        step += 1;
        yield* scripts[Math.min(step, scripts.length) - 1] ?? [];
      },
    },
  };
}

/** Runs the turn, ending it at `post_tool` of `endOn`; returns its events and the stages seen. */
async function endAt(
  profile: string,
  calls: readonly string[],
  endOn: string,
  { model, steps }: { model: TurnModel; steps: () => number } = writer(calls),
) {
  const seen: TurnStage[] = [];
  const events: TurnEvent[] = await Array.fromAsync(
    runTurn(
      {
        profile,
        input: { text: 'Go' },
        onStage: (ctx: StageContext): StageResult | undefined => {
          seen.push(ctx.stage);
          return ctx.stage === 'post_tool' && ctx.tool === endOn ? { end: true } : undefined;
        },
      },
      model,
    ),
  );
  return { events, seen, steps: steps() };
}

function doneOf(events: readonly TurnEvent[]) {
  const done = events.find((e) => e.type === 'done');
  assert(done?.type === 'done');
  return done;
}

function completedTools(events: readonly TurnEvent[]): string[] {
  return events.flatMap((e) =>
    e.type === 'tool' && e.tool.phase === 'complete' ? [e.tool.name] : [],
  );
}

Deno.test('end: post_tool ends the turn with the reply written before the call', async () => {
  const { events, seen, steps } = await endAt(ONE_AT_A_TIME, [PICK], PICK);
  assertEquals(steps, 1);
  assertEquals(doneOf(events).stop.kind, 'completed');
  assertEquals(replyText(keptReply(events)), 'Your fern needs water.');
  assertEquals(completedTools(events), [PICK]);
  assertEquals(seen.includes('before_end'), false);
  assertEquals(seen.at(-1), 'post_turn');
  assertEquals(
    events.filter((e) => e.type === 'error'),
    [],
  );
});

for (const [label, profile] of [
  ['one at a time', ONE_AT_A_TIME],
  ['side by side', SIDE_BY_SIDE],
] as const) {
  Deno.test(`end: every call of the step settles before the turn ends (${label})`, async () => {
    const { events, steps } = await endAt(profile, [PICK, NOTE], PICK);
    assertEquals(steps, 1);
    assertEquals(completedTools(events).toSorted(), [NOTE, PICK].toSorted());
    assertEquals(doneOf(events).stop.kind, 'completed');
  });
}

Deno.test('end: a turn no handler ends goes on as before', async () => {
  const { events, seen, steps } = await endAt(ONE_AT_A_TIME, [PICK], 'no_such_tool');
  assertEquals(steps, 2);
  assertEquals(replyText(keptReply(events)), 'Your fern needs water. Anything else?');
  assertEquals(seen.includes('before_end'), true);
});

Deno.test('applyStageResult: end only at post_tool, only as true, only where allowed', () => {
  const ok = applyStageResult({
    stage: 'post_tool',
    injectAllowed: true,
    endAllowed: true,
    result: { end: true },
  });
  assertEquals(ok.end, true);
  assertEquals(ok.warnings, []);

  const elsewhere = applyStageResult({
    stage: 'before_end',
    injectAllowed: true,
    endAllowed: true,
    result: { end: true },
  });
  assertEquals(elsewhere.end, undefined);
  assertEquals(elsewhere.warnings[0]?.code, 'affordance_not_allowed');

  const notTrue = applyStageResult({
    stage: 'post_tool',
    injectAllowed: true,
    endAllowed: true,
    result: { end: 'yes' },
  });
  assertEquals(notTrue.end, undefined);
  assertEquals(notTrue.warnings[0]?.code, 'end_invalid');

  const noTurn = applyStageResult({
    stage: 'post_tool',
    injectAllowed: false,
    result: { end: true },
  });
  assertEquals(noTurn.end, undefined);
  assertEquals(noTurn.warnings[0]?.code, 'end_not_allowed');
});

Deno.test('end: a model that wrote nothing before its calls ends with an empty reply', async () => {
  const silent = scripted([
    [{ type: 'tool', tool: { name: PICK, arguments: { val: 1 }, callId: 'c0' } }],
  ]);
  const { events, steps } = await endAt(ONE_AT_A_TIME, [PICK], PICK, silent);
  assertEquals(steps, 1);
  assertEquals(doneOf(events).stop.kind, 'completed');
  assertEquals(replyText(keptReply(events)), '');
});

const sensorThenAnswer = (): { model: TurnModel; steps: () => number } =>
  scripted([
    [{ type: 'tool', tool: { name: 'fetch_sensor', arguments: { sensor: 'a' }, callId: 'c0' } }],
    [
      {
        type: 'tool',
        tool: { name: ANSWER_TOOL, arguments: { message: 'Dry' }, callId: 'answer_1' },
      },
    ],
  ]);

Deno.test('end: a structured turn ended before its answer stops answer_missing', async () => {
  const { events, steps } = await endAt(
    ANSWERS,
    ['fetch_sensor'],
    'fetch_sensor',
    sensorThenAnswer(),
  );
  assertEquals(steps, 1);
  assertEquals(doneOf(events).stop.kind, 'answer_missing');
});

Deno.test('end: a reply the checks refuse is retried, and the retry is a new model step', async () => {
  const { events, steps } = await endAt(
    ANSWERS_WITH_REPAIR,
    ['fetch_sensor'],
    'fetch_sensor',
    sensorThenAnswer(),
  );
  assertEquals(steps, 2);
  assertEquals(
    events.flatMap((e) => (e.type === 'attempt' ? [e.reason] : [])),
    ['validation'],
  );
  assertEquals(
    events.flatMap((e) => (e.type === 'structured' ? [e.structured] : [])),
    [{ message: 'Dry' }],
  );
  assertEquals(doneOf(events).stop.kind, 'completed');
});
