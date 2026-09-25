import { assertEquals } from '@std/assert';
import { type PendingToolGate, pruneGates } from '../../react/src/server/session-store.ts';

const HOUR_MS = 60 * 60 * 1000;

function gate(createdAt: number): PendingToolGate {
  return {
    name: 'issue_refund',
    input: {},
    gate: { kind: 'permission', permission: 'always_confirm' },
    promoted: [],
    turnInput: { text: 'refund order 42' },
    createdAt,
  };
}

Deno.test('pruneGates keeps every waiting gate and drops only expired ones', () => {
  const now = Date.now();
  const waiting = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [`gate_${i}`, gate(now - i)]),
  );
  const kept = pruneGates({ ...waiting, stale: gate(now - HOUR_MS) }, now);
  assertEquals(Object.keys(kept).length, 100);
  assertEquals('stale' in kept, false);
});
