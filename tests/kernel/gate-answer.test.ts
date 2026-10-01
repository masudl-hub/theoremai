import { assertEquals, assertThrows } from '@std/assert';
import { TheoremError } from '../../src/guardrails/error.ts';
import {
  answerGatedCall,
  gateExpired,
  type HeldGatedCall,
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

const HELD: HeldGatedCall = {
  name: 'delete_resource',
  arguments: { id: 'model-chosen' },
  permission: 'session_consent',
};

Deno.test('a refusal runs nothing new: the model input and the permissions stay', () => {
  for (const [decision, cause] of [
    ['deny', 'declined'],
    ['abandon', 'abandoned'],
  ] as const) {
    assertEquals(answerGatedCall({ callId: 'c1', decision }, HELD, ['search']), {
      resume: { granted: false, cause },
      input: { id: 'model-chosen' },
      sessionPermissions: ['search'],
    });
  }
});

Deno.test('only an approval takes an edit or a typed key', () => {
  for (const decision of ['deny', 'abandon'] as const) {
    for (const extra of [{ input: { id: 'x' } }, { secret: 'k' }]) {
      const err = assertThrows(
        () => answerGatedCall({ callId: 'c1', decision, ...extra }, HELD, []),
        TheoremError,
      );
      assertEquals(err.kind, 'request');
    }
  }
});

Deno.test('an approval runs the call with the edit, recording what the model proposed', () => {
  assertEquals(
    answerGatedCall({ callId: 'c1', decision: 'approve', input: { id: 'edited' } }, HELD, []),
    {
      resume: { granted: true, edited: { from: { id: 'model-chosen' } } },
      input: { id: 'edited' },
      sessionPermissions: ['delete_resource'],
    },
  );
  assertEquals(answerGatedCall({ callId: 'c1', decision: 'approve' }, HELD, ['delete_resource']), {
    resume: { granted: true },
    input: { id: 'model-chosen' },
    sessionPermissions: ['delete_resource'],
  });
});

Deno.test('a typed key answers only a sign-in gate, as its slot credential', () => {
  const err = assertThrows(
    () => answerGatedCall({ callId: 'c1', decision: 'approve', secret: 'k' }, HELD, []),
    TheoremError,
  );
  assertEquals(err.kind, 'request');
  const answered = answerGatedCall(
    { callId: 'c1', decision: 'approve', secret: 'typed-key' },
    {
      name: 'fetch_report',
      arguments: {},
      auth: { slot: 'tracker', authType: 'bearer', service: 'Tracker' },
    },
    [],
  );
  assertEquals(answered.typed?.slot, 'tracker');
  assertEquals(answered.resume, { granted: true });
});

Deno.test('a refused sign-in gate resumes as a sign-in, so the model reads its sign-in note', () => {
  const signInCall: HeldGatedCall = {
    name: 'fetch_report',
    arguments: {},
    auth: { slot: 'tracker', authType: 'bearer', service: 'Tracker' },
  };
  assertEquals(answerGatedCall({ callId: 'c1', decision: 'deny' }, signInCall, []).resume, {
    granted: false,
    cause: 'declined',
    signIn: true,
  });
  assertEquals(answerGatedCall({ callId: 'c1', decision: 'abandon' }, signInCall, []).resume, {
    granted: false,
    cause: 'abandoned',
    signIn: true,
  });
  assertEquals(resumeForAnswer({ decision: 'approve' }, true), { granted: true });
});
