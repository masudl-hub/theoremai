import { assertEquals } from '@std/assert';
import { toolCallsOf } from '../../src/interface/mod.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';

const call = { name: 'write_report', callId: 'call_1' };

const draft = (text: string, at: number): TurnEvent => ({
  type: 'tool',
  tool: { ...call, phase: 'draft', text, at },
});

Deno.test("a tool's drafts fold into its call's output so far, and settling clears it", () => {
  const running: TurnEvent[] = [
    { type: 'tool', tool: { ...call, arguments: {} } },
    { type: 'tool', tool: { ...call, phase: 'running', at: 1 } },
    draft('Soil is ', 2),
    draft('dry.', 3),
  ];
  const [drafting] = toolCallsOf(running);
  assertEquals(drafting?.outputDraft, 'Soil is dry.');

  const [settled] = toolCallsOf([
    ...running,
    { type: 'tool', tool: { ...call, phase: 'complete', output: { finding: 'dry' }, at: 4 } },
  ]);
  assertEquals('outputDraft' in (settled ?? {}), false);
  assertEquals(settled?.state?.phase, 'complete');
});

Deno.test('a call that runs again drops the drafts of its last run', () => {
  const [again] = toolCallsOf([
    { type: 'tool', tool: { ...call, arguments: {} } },
    { type: 'tool', tool: { ...call, phase: 'running', at: 1 } },
    draft('first', 2),
    { type: 'tool', tool: { ...call, phase: 'running', at: 3 } },
  ]);
  assertEquals('outputDraft' in (again ?? {}), false);
});
