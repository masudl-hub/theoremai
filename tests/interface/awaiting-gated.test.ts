/**
 * Interface helpers for gated vs awaiting tool contexts.
 */

import { assertEquals } from '@std/assert';
import { awaitingFromEvents, gatedToolFromEvents } from '../../src/interface/session.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';
import { toolSnapshot } from '../fixtures/events.ts';

Deno.test('gatedToolFromEvents: reads gate phase', () => {
  const events: TurnEvent[] = [
    { type: 'tool', tool: { name: 'risky', callId: 'g1', arguments: { id: '1' } } },
    {
      type: 'tool',
      tool: {
        name: 'risky',
        callId: 'g1',
        at: 1,
        phase: 'gate',
        gate: { kind: 'permission', tool: 'risky', permission: 'always_confirm' },
      },
    },
    { type: 'done', stop: { kind: 'gate' }, tools: toolSnapshot('risky') },
  ];
  const gated = gatedToolFromEvents(events);
  assertEquals(gated?.name, 'risky');
  assertEquals(gated?.callId, 'g1');
  assertEquals(gated?.gateKind, 'permission');
});

Deno.test('awaitingFromEvents: reads ask_user awaiting payload', () => {
  const events: TurnEvent[] = [
    {
      type: 'tool',
      tool: {
        name: 'ask_user',
        callId: 'a1',
        arguments: { kind: 'choice', prompt: 'Pick one', options: ['a', 'b'] },
      },
    },
    {
      type: 'tool',
      tool: {
        name: 'ask_user',
        callId: 'a1',
        at: 1,
        phase: 'complete',
        output: {
          status: 'awaiting_user_input',
          kind: 'choice',
          prompt: 'Pick one',
          options: ['a', 'b'],
        },
      },
    },
    { type: 'done', stop: { kind: 'completed' } },
  ];
  const awaiting = awaitingFromEvents(events);
  assertEquals(awaiting?.name, 'ask_user');
  assertEquals(awaiting?.callId, 'a1');
  assertEquals(awaiting?.kind, 'choice');
  assertEquals(awaiting?.prompt, 'Pick one');
  assertEquals(awaiting?.options, ['a', 'b']);
});

Deno.test('awaitingFromEvents: null when complete is not awaiting', () => {
  const events: TurnEvent[] = [
    { type: 'tool', tool: { name: 'lookup', callId: 'c1', arguments: {} } },
    {
      type: 'tool',
      tool: { name: 'lookup', callId: 'c1', at: 1, phase: 'complete', output: { finding: 'ok' } },
    },
  ];
  assertEquals(awaitingFromEvents(events), null);
});
