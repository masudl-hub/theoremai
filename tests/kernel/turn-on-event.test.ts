import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { assertRejects } from '@std/assert';
import { registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { TurnEvent, TurnModel } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

const PROFILE = 'on_event_bot';
registerProfile(
  defineProfile({
    type: 'text',
    identity: { handle: 'test', system: 'test' },
    id: PROFILE,
    ...geminiModels('gemini35FlashLite'),
    tools: { allow: [] },
    inputs: { text: true },
  }),
);

const replying: TurnModel = {
  complete: () =>
    (async function* () {
      yield { type: 'text' as const, text: 'hi' };
      yield { type: 'done' as const, stop: { kind: 'completed' } };
    })(),
};

Deno.test('onEvent reads each event of a turn before the caller gets it', async () => {
  const read: TurnEvent[] = [];
  const order: string[] = [];
  const request = {
    profile: PROFILE,
    input: { text: 'hello' },
    onEvent: (event: TurnEvent) => {
      read.push(event);
      order.push(`read ${event.type}`);
    },
  };
  const caller: TurnEvent[] = [];
  for await (const event of runTurn(request, replying)) {
    order.push(`caller ${event.type}`);
    caller.push(event);
  }
  assertEquals(read, caller);
  assertEquals(order.indexOf('read done') + 1, order.indexOf('caller done'));
});

Deno.test('a throw from onEvent ends the turn with that error', async () => {
  const request = {
    profile: PROFILE,
    input: { text: 'hello' },
    onEvent: (event: TurnEvent) => {
      if (event.type === 'done') throw new Error('save failed');
    },
  };
  await assertRejects(
    async () => {
      for await (const _event of runTurn(request, replying)) {
        // the caller reads on until the throw
      }
    },
    Error,
    'save failed',
  );
});
