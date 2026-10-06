import '../fixtures/test-host.ts';
import { eventHasCanary, mintCanary } from '../../src/guardrails/canary.ts';
import { scopeOf } from '../../src/guardrails/detect-at.ts';
import { readReply } from '../../src/guardrails/detect-reply.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import { DETECT_RULES, EGRESS_RULES } from '../../src/guardrails/rules.ts';
import { CIRCULAR, scanTextOf, textForScan } from '../../src/guardrails/serialize.ts';
import type { GuardrailHit } from '../../src/guardrails/types.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';

/** A profile that sets no guardrails. */
const POLICY = resolveGuardrailPolicy(undefined);

/** The hits a reply of `structured` output is blocked on under {@linkcode POLICY}, if it is. */
function blockedOn(structured: unknown, canary?: string): GuardrailHit[] | undefined {
  return readReply({ text: 'ok', structured }, POLICY.detect, {
    boundary: 'reply',
    withheld: false,
    scope: scopeOf(POLICY, canary ? { canary } : {}),
  }).blocked;
}

Deno.test('textForScan renders plain values', () => {
  assertEquals(textForScan({ a: 1 }), { text: '{"a":1}', unscannable: false });
  assertEquals(textForScan('already text'), { text: 'already text', unscannable: false });
  assertEquals(textForScan(undefined), { text: '', unscannable: false });
});

Deno.test('textForScan collapses cycles instead of throwing', () => {
  const circular: Record<string, unknown> = { name: 'root' };
  circular.self = circular;
  const result = textForScan(circular);
  assertEquals(result.unscannable, false);
  assertEquals(result.text.includes(CIRCULAR), true);
  assertEquals(result.text.includes('root'), true);
});

Deno.test('textForScan renders bigints as digits', () => {
  const result = textForScan({ n: BigInt('9007199254740993') });
  assertEquals(result.unscannable, false);
  assertEquals(result.text.includes('9007199254740993'), true);
});

Deno.test('textForScan reports a payload it cannot render', () => {
  const hostile = {
    toJSON() {
      throw new Error('nope');
    },
  };
  assertEquals(textForScan(hostile), { text: '', unscannable: true });
});

Deno.test('scanTextOf discards the unscannable signal', () => {
  assertEquals(scanTextOf({ a: 1 }), '{"a":1}');
  assertEquals(
    scanTextOf({
      toJSON() {
        throw new Error('nope');
      },
    }),
    '',
  );
});

Deno.test('egress survives a circular structured payload', () => {
  const circular: Record<string, unknown> = { answer: 'fine' };
  circular.self = circular;
  assertEquals(blockedOn(circular), undefined);
});

Deno.test('egress still finds a leak inside a circular payload', () => {
  const canary = mintCanary();
  const circular: Record<string, unknown> = { answer: `token ${canary}` };
  circular.self = circular;
  assertEquals(
    blockedOn(circular, canary)?.some((h) => h.rule === DETECT_RULES.canary_leak),
    true,
  );
});

Deno.test('egress fails closed on a payload it cannot inspect', () => {
  const hostile = {
    toJSON() {
      throw new Error('nope');
    },
  };
  assertEquals(
    blockedOn(hostile)?.some((h) => h.rule === EGRESS_RULES.unscannable),
    true,
  );
});

Deno.test('eventHasCanary survives a circular structured event', () => {
  const canary = mintCanary();
  const structured: Record<string, unknown> = { answer: 'fine' };
  structured.self = structured;
  assertEquals(eventHasCanary({ type: 'structured', structured } as TurnEvent, canary), false);
});

Deno.test('eventHasCanary still finds a canary in a circular structured event', () => {
  const canary = mintCanary();
  const structured: Record<string, unknown> = { answer: `leak ${canary}` };
  structured.self = structured;
  assertEquals(eventHasCanary({ type: 'structured', structured } as TurnEvent, canary), true);
});
