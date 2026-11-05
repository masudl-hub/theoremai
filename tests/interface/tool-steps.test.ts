import { assertEquals } from '@std/assert';
import { toolCallsOf } from '../../src/interface/mod.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';

const think = { name: 'think_deeply', callId: 'call_1' };
const search = { name: 'web_search', callId: 'call_a' };

/** A call event of the agent `think_deeply` ran, as the kernel carries it. */
const step = (event: TurnEvent, at = 1): TurnEvent => ({
  type: 'tool',
  tool: { ...think, phase: 'progress', data: { agent: 'research', event }, at },
});

Deno.test("an agent tool's call holds the calls its agent made, settled as they settle", () => {
  const [call] = toolCallsOf([
    { type: 'tool', tool: { ...think, arguments: { text: 'thrips' } } },
    { type: 'tool', tool: { ...think, phase: 'running', at: 1 } },
    step({ type: 'tool', tool: { ...search, arguments: { q: 'neem' } } }),
    step({ type: 'tool', tool: { ...search, phase: 'running', at: 2 } }),
    step({ type: 'tool', tool: { ...search, phase: 'complete', output: 'ok', at: 3 } }),
    { type: 'tool', tool: { ...think, phase: 'complete', output: { text: 'done' }, at: 4 } },
  ]);
  assertEquals(call?.steps?.length, 1);
  assertEquals(call?.steps?.[0]?.arguments, { q: 'neem' });
  assertEquals(call?.steps?.[0]?.state?.phase, 'complete');
  assertEquals(call?.state?.phase, 'complete');
});

Deno.test("an agent's agent's calls nest under the call that ran it", () => {
  const inner = { name: 'read_page', callId: 'call_x' };
  const [call] = toolCallsOf([
    { type: 'tool', tool: { ...think, arguments: {} } },
    step({ type: 'tool', tool: { ...search, arguments: {} } }),
    step({
      type: 'tool',
      tool: {
        ...search,
        phase: 'progress',
        data: { agent: 'reader', event: { type: 'tool', tool: { ...inner, arguments: {} } } },
        at: 2,
      },
    }),
  ]);
  assertEquals(call?.steps?.[0]?.steps?.[0]?.name, 'read_page');
});

Deno.test('progress that is not an agent step, or does not fit its call, leaves the call as it was', () => {
  const [call] = toolCallsOf([
    { type: 'tool', tool: { ...think, arguments: {} } },
    {
      type: 'tool',
      tool: { ...think, phase: 'progress', data: { kind: 'auth_token_refreshed' }, at: 1 },
    },
    step({ type: 'text', text: 'thinking' }),
    step({ type: 'tool', tool: { ...search, phase: 'complete', output: 'ok', at: 2 } }),
    step({ type: 'tool', tool: { name: 'x' } } as unknown as TurnEvent),
  ]);
  assertEquals(call?.steps, undefined);
});
