import { assertEquals, assertThrows } from '@std/assert';
import { TheoremError } from '../../src/guardrails/error.ts';
import {
  gateExpired,
  resolveGateTtlMs,
  resumeForAnswer,
} from '../../src/kernel/tools/gate-answer.ts';

Deno.test('a gate waits 30 minutes unless the host sets gateTtlMs', () => {
  assertEquals(resolveGateTtlMs('runSession', undefined), 30 * 60 * 1000);
  assertEquals(resolveGateTtlMs('runSession', 5), 5);
});

Deno.test('a gateTtlMs that is not a positive number is a config error naming its owner', () => {
  for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const err = assertThrows(() => resolveGateTtlMs('runSession', ttl), TheoremError);
    assertEquals(err.kind, 'config');
    assertEquals(err.message.startsWith('runSession gateTtlMs'), true);
  }
});

Deno.test('a gate expires once it has waited its full TTL', () => {
  assertEquals(gateExpired(1_000, 1_999, 1_000), false);
  assertEquals(gateExpired(1_000, 2_000, 1_000), true);
});

Deno.test('each decision resumes the gated call its own way', () => {
  assertEquals(resumeForAnswer({ decision: 'approve' }), { granted: true });
  assertEquals(resumeForAnswer({ decision: 'approve', edited: { from: { amount: 5 } } }), {
    granted: true,
    edited: { from: { amount: 5 } },
  });
  assertEquals(resumeForAnswer({ decision: 'deny' }), { granted: false, cause: 'declined' });
  assertEquals(resumeForAnswer({ decision: 'abandon' }), { granted: false, cause: 'abandoned' });
});
