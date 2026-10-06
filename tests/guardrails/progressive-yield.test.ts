import '../fixtures/test-host.ts';
import { mintCanary } from '../../src/guardrails/canary.ts';
import { FIXED_CANARY } from '../../src/guardrails/corpus/canary-egress-attacks.ts';
import { TEST_OPENAI_KEY } from '../../src/guardrails/corpus/secrets.ts';
import { createProgressiveYieldGate } from '../../src/guardrails/progressive-yield.ts';
import { DETECT_RULES } from '../../src/guardrails/rules.ts';
import type { GuardrailContext } from '../../src/guardrails/types.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { CANARY_OPENING } from '../fixtures/canary.ts';
import { replyGate } from '../fixtures/detect.ts';

function ctx(canary?: string): GuardrailContext {
  return {
    stage: 'output_final',
    trust: 'untrusted',
    profileId: 'chat',
    ...(canary ? { canary } : {}),
  };
}

Deno.test('createProgressiveYieldGate blocks canary before release', () => {
  const canary = mintCanary();
  const gate = createProgressiveYieldGate({ context: ctx(canary) });
  const result = gate.process(`prefix ${canary}`);
  assertEquals(result.blocked, true);
  if (result.blocked) {
    assertEquals(
      result.hits.some((h) => h.rule === DETECT_RULES.canary_leak),
      true,
    );
  }
  assertEquals(gate.accumulated().includes(canary), true);
});

Deno.test('createProgressiveYieldGate scans only the canary when it is given no detectors', () => {
  const gate = createProgressiveYieldGate({ context: ctx(mintCanary()) });
  const result = gate.process(`key=${TEST_OPENAI_KEY} <user_data>`);
  assertEquals(result.blocked, false);
});

Deno.test('createProgressiveYieldGate holds a key a detector blocks until it settles, then stops', () => {
  const gate = replyGate(ctx());
  // The key could still run on, so it is held, not yet a match.
  const held = gate.process(`key=${TEST_OPENAI_KEY}`);
  assertEquals(held, { blocked: false, emit: '' });
  const result = gate.process(' and more');
  assertEquals(result.blocked, true);
  if (result.blocked) {
    assertEquals(result.boundary, 'reply');
    assertEquals([...new Set(result.hits.map((hit) => hit.rule))], [DETECT_RULES.credentials]);
  }
});

Deno.test('createProgressiveYieldGate holds a canary split across chunks', () => {
  const canary = mintCanary();
  const gate = createProgressiveYieldGate({ context: ctx(canary) });
  const half = CANARY_OPENING;
  const first = gate.process(canary.slice(0, half));
  assertEquals(first.blocked, false);
  if (!first.blocked) {
    assertEquals(first.emit, '');
  }
  const second = gate.process(canary.slice(half));
  assertEquals(second.blocked, true);
});

Deno.test('createProgressiveYieldGate canary-only holds just a tail that could start a leak', () => {
  const gate = createProgressiveYieldGate({ context: ctx(FIXED_CANARY) });
  const lead = FIXED_CANARY.slice(0, 5);
  gate.process(`${'w'.repeat(500)}${lead}`);
  assertEquals(gate.unreleased(), lead);
});

Deno.test('createProgressiveYieldGate canary-only releases at once what cannot start a leak', () => {
  const gate = createProgressiveYieldGate({ context: ctx(FIXED_CANARY) });
  gate.process('w'.repeat(500));
  assertEquals(gate.unreleased(), '');
});

Deno.test('createProgressiveYieldGate canary-only holds a separated opening across chunks', () => {
  const gate = createProgressiveYieldGate({ context: ctx(FIXED_CANARY) });
  const spoken = [...FIXED_CANARY.toUpperCase()].join(' - ');
  const half = CANARY_OPENING * ' - X'.length;
  const first = gate.process(`Sure: ${spoken.slice(0, half)}`);
  assertEquals(first, { blocked: false, emit: 'Sure: ' });
  assertEquals(gate.process(spoken.slice(half)).blocked, true);
});

Deno.test('createProgressiveYieldGate canary-only does not hold a PEM body', () => {
  const gate = createProgressiveYieldGate({ context: ctx(FIXED_CANARY) });
  gate.process(`-----BEGIN PRIVATE KEY-----\n${'p'.repeat(200)}`);
  assertEquals(gate.unreleased(), '');
});

Deno.test('a gate with nothing to read for releases every fragment as it comes', () => {
  const gate = createProgressiveYieldGate({ context: ctx() });
  assertEquals(gate.process(''), { blocked: false, emit: '' });
  assertEquals(gate.process('x'), { blocked: false, emit: 'x' });
  assertEquals(gate.unreleased(), '');
});

Deno.test('a canary-shaped tail is held from where it begins in the unreleased text', () => {
  const canary = mintCanary();
  const gate = createProgressiveYieldGate({ context: ctx(canary) });
  assertEquals(gate.process('w'.repeat(50)), { blocked: false, emit: 'w'.repeat(50) });
  assertEquals(gate.process(canary.slice(0, 4)), { blocked: false, emit: '' });
  assertEquals(gate.unreleased(), canary.slice(0, 4));
});

Deno.test('draining the unreleased tail takes only what was not yet released, and flush then adds nothing', () => {
  const canary = 'b8d3e3616fea1b7bfcb0bfb750bffe3d';
  const opening = canary.slice(0, 4);
  const gate = createProgressiveYieldGate({ context: ctx(canary) });
  assertEquals(gate.process(`Here: ${opening}`), { blocked: false, emit: 'Here: ' });
  assertEquals(gate.drainUnreleased(), opening);
  assertEquals(gate.unreleased(), '');
  assertEquals(gate.flush(), { blocked: false, emit: '' });
  assertEquals(gate.accumulated(), `Here: ${opening}`);
});

Deno.test('createProgressiveYieldGate reads the carry in front of its window', () => {
  const canary = mintCanary();
  const half = CANARY_OPENING;
  const first = createProgressiveYieldGate({ context: ctx(canary) });
  // No letters or digits in the lead-in: they could extend the opening in some reading.
  assertEquals(first.process(`>> ${canary.slice(0, half)}`), {
    blocked: false,
    emit: '>> ',
  });
  assertEquals(first.flush().blocked, false);
  // The next window of the same canary completes the token: one match.
  const second = createProgressiveYieldGate({ context: ctx(canary), carry: first.carryOut() });
  assertEquals(second.process(canary.slice(half)).blocked, true);
});

Deno.test('createProgressiveYieldGate holds a window opening that continues the carry', () => {
  const canary = 'abcdef0123456789abcdef0123456789';
  const gate = createProgressiveYieldGate({ context: ctx(canary), carry: 'abcdef' });
  // "0123" continues the carried opening, so it is held; "5" breaks it, so "zz, 5" goes.
  assertEquals(gate.process('0123'), { blocked: false, emit: '' });
  const other = createProgressiveYieldGate({ context: ctx(canary), carry: 'abcdef' });
  assertEquals(other.process('zz, 5'), { blocked: false, emit: 'zz, 5' });
});

Deno.test('createProgressiveYieldGate carries only the tail that could open a leak', () => {
  const gate = createProgressiveYieldGate({ context: ctx(FIXED_CANARY) });
  gate.process('nothing to carry here');
  assertEquals(gate.carryOut(), 're');
  assertEquals(createProgressiveYieldGate({ context: ctx() }).carryOut(), '');
});

Deno.test('createProgressiveYieldGate releases a three-character opening and blocks the leak it grows into', () => {
  const canary = 'b8d3e3616fea1b7bfcb0bfb750bffe3d';
  const gate = createProgressiveYieldGate({ context: ctx(canary) });
  // Shorter than an opening the hold keeps back: it goes out.
  assertEquals(gate.process(`Here: ${canary.slice(0, 3)}`), {
    blocked: false,
    emit: `Here: ${canary.slice(0, 3)}`,
  });
  // The rest of the token still reads as one leak with what was released.
  const next = gate.process(canary.slice(3));
  assertEquals(next.blocked, true);
});

Deno.test('createProgressiveYieldGate holds a four-character opening', () => {
  const canary = 'b8d3e3616fea1b7bfcb0bfb750bffe3d';
  const gate = createProgressiveYieldGate({ context: ctx(canary) });
  assertEquals(gate.process(`Here: ${canary.slice(0, 4)}`), {
    blocked: false,
    emit: 'Here: ',
  });
  assertEquals(gate.process(canary.slice(4)).blocked, true);
});

Deno.test('createProgressiveYieldGate carries a released short opening into the next window', () => {
  const canary = 'b8d3e3616fea1b7bfcb0bfb750bffe3d';
  const first = createProgressiveYieldGate({ context: ctx(canary) });
  assertEquals(first.process(`Here: ${canary.slice(0, 3)}`), {
    blocked: false,
    emit: `Here: ${canary.slice(0, 3)}`,
  });
  assertEquals(first.flush(), { blocked: false, emit: '' });
  // Three released characters and fifteen more make one sixteen-character run.
  const next = createProgressiveYieldGate({ context: ctx(canary), carry: first.carryOut() });
  assertEquals(next.process(canary.slice(3, 18)).blocked, true);
});
