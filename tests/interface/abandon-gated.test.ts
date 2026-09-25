/**
 * Abandon tool gate without continuing the model (send-now while gated).
 */

import { assertEquals } from '@std/assert';
import { abandonGatedToolSession, emptyInterfaceTurnSession } from '../../src/interface/session.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';

Deno.test('abandonGatedToolSession: clears gate and records cancelled tool', () => {
  const events: TurnEvent[] = [
    { type: 'text', text: 'Let me check that.' },
    {
      type: 'tool',
      tool: {
        name: 'dangerous',
        phase: 'gate',
        callId: 'c1',
        arguments: { x: 1 },
        gate: {
          kind: 'permission',
          tool: 'dangerous',
          permission: 'always_confirm',
        },
      },
    },
    { type: 'done', stop: { kind: 'gate' } },
  ];

  const before = {
    ...emptyInterfaceTurnSession(),
    history: [{ role: 'user' as const, content: 'do it' }],
    gatedTool: {
      name: 'dangerous',
      input: { x: 1 },
      callId: 'c1',
      arguments: { x: 1 },
      gateKind: 'permission' as const,
      permission: 'always_confirm' as const,
    },
    assistantEvents: events,
  };

  const { session, finalizedEvents } = abandonGatedToolSession(before, undefined);
  assertEquals(session.gatedTool, null);
  assertEquals(session.assistantEvents, []);
  assertEquals(
    finalizedEvents.some(
      (e) => e.type === 'tool' && e.tool?.phase === 'error' && e.tool.failure?.code === 'cancelled',
    ),
    true,
  );
  assertEquals(
    session.history.some((m) => m.role === 'assistant' && m.content === 'Let me check that.'),
    true,
  );
  assertEquals(
    session.history.some((m) => m.role === 'tool'),
    true,
  );
});

Deno.test('abandonGatedToolSession: no-op when not gated', () => {
  const session = emptyInterfaceTurnSession();
  const next = abandonGatedToolSession(session, undefined);
  assertEquals(next.session, session);
});
