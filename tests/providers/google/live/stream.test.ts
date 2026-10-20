import { assertEquals } from '@std/assert';
import { closeError, turnPhaseFromMessage } from '../../../../src/providers/google/live/stream.ts';

Deno.test('turnPhaseFromMessage: serverContent.interactionStatus is authoritative over turnComplete', () => {
  assertEquals(turnPhaseFromMessage({ serverContent: { turnComplete: true } }, []), 'complete');
  assertEquals(
    turnPhaseFromMessage({ serverContent: { modelTurn: { parts: [] } } }, []),
    'streaming',
  );
  // gemini-3.8-live-extended-thinking (probe 23/09/2026): a tool flow sends
  // turnComplete + IN_PROGRESS before the tool call, then turnComplete + IDLE.
  assertEquals(
    turnPhaseFromMessage(
      { serverContent: { turnComplete: true, interactionStatus: 'IN_PROGRESS' } },
      [],
    ),
    'streaming',
  );
  assertEquals(
    turnPhaseFromMessage({ serverContent: { turnComplete: true, interactionStatus: 'IDLE' } }, []),
    'complete',
  );
  // Only serverContent carries it; a top-level field is not the wire shape.
  assertEquals(
    turnPhaseFromMessage(
      { serverContent: { turnComplete: true }, interactionStatus: 'IN_PROGRESS' },
      [],
    ),
    'complete',
  );
  assertEquals(
    turnPhaseFromMessage({ serverContent: { interrupted: true, interactionStatus: 'IDLE' } }, [
      { type: 'done', interrupted: true, stop: { kind: 'interrupted' } },
    ]),
    'abort',
  );
});

Deno.test('turnPhaseFromMessage: an empty frame keeps the turn streaming', () => {
  // gemini-3.8-live sends bare `{}` frames mid-turn (probe 23/09/2026).
  assertEquals(turnPhaseFromMessage({}, []), 'streaming');
});

Deno.test('Live close errors carry the kind of their close code', () => {
  for (const [code, kind] of [
    [1006, 'network'],
    [1007, 'unsupported'],
    [1008, 'unsupported'],
    [1011, 'unavailable'],
    [1013, 'busy'],
    [1000, 'unavailable'],
    [4000, 'unavailable'],
  ] as const) {
    assertEquals(closeError(code, 'closed', 'setup').kind, kind);
  }
});

Deno.test('Live closes that name a quota are rate_limit, whatever their code', () => {
  const reason = 'You exceeded your current quota, please check your plan and billing details.';
  assertEquals(closeError(1011, reason, 'setup').kind, 'rate_limit');
  assertEquals(closeError(1011, reason, 'session').kind, 'rate_limit');
});

Deno.test('Live closes that name a refused key are auth, not unsupported', () => {
  assertEquals(
    closeError(1007, 'API key not valid. Please pass a valid API key.', 'setup').kind,
    'auth',
  );
  // A 1007 for anything else is still what its code says.
  assertEquals(closeError(1007, 'Invalid frame', 'setup').kind, 'unsupported');
});
