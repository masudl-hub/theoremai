import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { StepLimitMode } from '../../src/kernel/schema.ts';
import type { ModelEvent, ModelRequest, TurnEvent, TurnModel } from '../../src/kernel/types.ts';
import { finalStop } from '../fixtures/events.ts';
import { HOST_BINDINGS } from '../fixtures/models.ts';

function stepLimitProfile(id: string, maxSteps: number, atStepLimit?: StepLimitMode) {
  return defineProfile({
    type: 'text',
    identity: { handle: 'test', system: 'test' },
    id,
    models: {
      gemini35FlashLite: {
        ...HOST_BINDINGS.gemini35FlashLite,
        builtInTools: ['googleSearch'],
      },
    },
    maxSteps,
    tools: { allow: ['fetch_sensor'] },
    ...(atStepLimit ? { turnBehaviour: { atStepLimit } } : {}),
    inputs: { text: true },
    guardrails: { quota: { perDay: 100 } },
  });
}

const SENSOR_CALL: ModelEvent[] = [
  {
    type: 'tool',
    tool: { name: 'fetch_sensor', arguments: { sensor: 'soil' }, callId: 'call_1' },
  },
  { type: 'done', stop: { kind: 'tool' } },
];

const ANSWER: ModelEvent[] = [
  { type: 'text', text: 'Soil reads 22%.' },
  { type: 'done', stop: { kind: 'completed' } },
];

/** Runs the turn against a model that calls the sensor while it has it, and answers once it has not. */
async function runToLimit(profile: string): Promise<{
  events: TurnEvent[];
  requests: ModelRequest[];
}> {
  const requests: ModelRequest[] = [];
  const provider: TurnModel = {
    async *complete(request) {
      await Promise.resolve();
      requests.push(request);
      yield* request.wireTools?.length ? SENSOR_CALL : ANSWER;
    },
  };
  const events: TurnEvent[] = [];
  for await (const event of runTurn({ profile, input: { text: 'Check soil' } }, provider)) {
    events.push(event);
  }
  return { events, requests };
}

function replyOf(events: TurnEvent[]): string {
  return events.flatMap((event) => (event.type === 'text' ? [event.text] : [])).join('');
}

Deno.test('a turn that spends its last step on tools stops as step_limit with no answer', async () => {
  registerProfile(stepLimitProfile('step_limit_stop', 2));
  const { events, requests } = await runToLimit('step_limit_stop');
  assertEquals(requests.length, 2);
  assertEquals(finalStop(events)?.kind, 'step_limit');
  assertEquals(replyOf(events), '');
  const dones = events.flatMap((event) => (event.type === 'done' ? [event] : []));
  assertEquals(dones.at(-1)?.stop.kind, 'step_limit');
  assertEquals(dones.at(-1)?.tools, undefined);
});

Deno.test("atStepLimit 'answer' sends the last step without tools, so the turn answers", async () => {
  registerProfile(stepLimitProfile('step_limit_answer', 3, 'answer'));
  const { events, requests } = await runToLimit('step_limit_answer');
  assertEquals(
    requests.map((request) => [request.wireTools?.length ?? 0, request.builtins.length]),
    [
      [1, 1],
      [1, 1],
      [0, 0],
    ],
  );
  assertEquals(finalStop(events)?.kind, 'completed');
  assertEquals(replyOf(events), 'Soil reads 22%.');
  const lastHistory = requests.at(-1)?.history ?? [];
  assertEquals(lastHistory.filter((message) => message.role === 'tool').length, 2);
});

Deno.test("atStepLimit 'answer' leaves a turn that answers early untouched", async () => {
  registerProfile(stepLimitProfile('step_limit_early', 3, 'answer'));
  const requests: ModelRequest[] = [];
  const provider: TurnModel = {
    async *complete(request) {
      await Promise.resolve();
      requests.push(request);
      yield* requests.length === 1 ? SENSOR_CALL : ANSWER;
    },
  };
  const events: TurnEvent[] = [];
  for await (const event of runTurn(
    { profile: 'step_limit_early', input: { text: 'Check soil' } },
    provider,
  )) {
    events.push(event);
  }
  assertEquals(
    requests.map((request) => request.wireTools?.length ?? 0),
    [1, 1],
  );
  assertEquals(finalStop(events)?.kind, 'completed');
});

Deno.test("atStepLimit 'answer' is refused with maxSteps 1, and off a text profile", () => {
  assertThrows(
    () => stepLimitProfile('step_limit_one', 1, 'answer'),
    Error,
    'leaves no step that can call a tool',
  );
  assertThrows(
    () =>
      defineProfile({
        type: 'live',
        id: 'step_limit_live',
        identity: { handle: 'test', system: 'test' },
        models: { gemini31FlashLive: HOST_BINDINGS.gemini31FlashLive },
        // @ts-expect-error a live profile's turnBehaviour takes allowSteering only
        turnBehaviour: { atStepLimit: 'answer' },
      }),
    Error,
  );
});
