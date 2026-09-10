/**
 * Abandon tool pause without continuing the model (send-now while paused).
 */

import { assertEquals } from '@std/assert';
import {
  abandonPausedToolSession,
  emptyInterfaceTurnSession,
} from '../../src/interface/session.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';

Deno.test('abandonPausedToolSession: clears pause and records cancelled tool', () => {
  const events: TurnEvent[] = [
    { type: 'text', text: 'Let me check that.' },
    {
      type: 'tool',
      tool: {
        name: 'dangerous',
        phase: 'pause',
        callId: 'c1',
        arguments: { x: 1 },
        pause: {
          kind: 'permission',
          tool: 'dangerous',
          input: { x: 1 },
          permission: 'always_confirm',
        },
      },
    },
    { type: 'done', stop: { kind: 'tool' } },
  ];

  const before = {
    ...emptyInterfaceTurnSession(),
    history: [{ role: 'user' as const, content: 'do it' }],
    pausedTool: {
      name: 'dangerous',
      input: { x: 1 },
      callId: 'c1',
      arguments: { x: 1 },
      pauseKind: 'permission' as const,
      permission: 'always_confirm' as const,
    },
    assistantEvents: events,
  };

  const { session, finalizedEvents } = abandonPausedToolSession(before);
  assertEquals(session.pausedTool, null);
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

Deno.test('abandonPausedToolSession: no-op when not paused', () => {
  const session = emptyInterfaceTurnSession();
  const next = abandonPausedToolSession(session);
  assertEquals(next.session, session);
});
