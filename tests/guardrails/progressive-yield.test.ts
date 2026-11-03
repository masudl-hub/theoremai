import '../fixtures/test-host.ts';
import { mintCanary } from '../../src/guardrails/canary.ts';
import { FIXED_CANARY } from '../../src/guardrails/corpus/canary-egress-attacks.ts';
import { TEST_OPENAI_KEY } from '../../src/guardrails/corpus/secrets.ts';
import { type DetectSpec, resolveDetect } from '../../src/guardrails/detectors.ts';
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

Deno.test('createProgressiveYieldGate blocks canary before release', async () => {
  const canary = mintCanary();
  const gate = await createProgressiveYieldGate({ context: ctx(canary) });
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

Deno.test('createProgressiveYieldGate scans only the canary when it is given no detectors', async () => {
  const gate = await createProgressiveYieldGate({ context: ctx(mintCanary()) });
  const result = gate.process(`key=${TEST_OPENAI_KEY} <user_data>`);
  assertEquals(result.blocked, false);
});

Deno.test('createProgressiveYieldGate holds a key a detector blocks until it settles, then stops', async () => {
  const gate = await replyGate(ctx());
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

Deno.test('createProgressiveYieldGate holds a canary split across chunks', async () => {
  const canary = mintCanary();
  const gate = await createProgressiveYieldGate({ context: ctx(canary) });
  const half = CANARY_OPENING;
  const first = gate.process(canary.slice(0, half));
  assertEquals(first.blocked, false);
  if (!first.blocked) {
    assertEquals(first.emit, '');
  }
  const second = gate.process(canary.slice(half));
  assertEquals(second.blocked, true);
});

Deno.test('createProgressiveYieldGate canary-only holds just a tail that could start a leak', async () => {
  const gate = await createProgressiveYieldGate({ context: ctx(FIXED_CANARY) });
  const lead = FIXED_CANARY.slice(0, 5);
  gate.process(`${'w'.repeat(500)}${lead}`);
  assertEquals(gate.unreleased(), lead);
});

Deno.test('createProgressiveYieldGate canary-only releases at once what cannot start a leak', async () => {
  const gate = await createProgressiveYieldGate({ context: ctx(FIXED_CANARY) });
  gate.process('w'.repeat(500));
  assertEquals(gate.unreleased(), '');
});

Deno.test('createProgressiveYieldGate canary-only holds a separated opening across chunks', async () => {
  const gate = await createProgressiveYieldGate({ context: ctx(FIXED_CANARY) });
  const spoken = [...FIXED_CANARY.toUpperCase()].join(' - ');
  const half = CANARY_OPENING * ' - X'.length;
  const first = gate.process(`Sure: ${spoken.slice(0, half)}`);
  assertEquals(first, { blocked: false, emit: 'Sure: ' });
  assertEquals(gate.process(spoken.slice(half)).blocked, true);
});

Deno.test('createProgressiveYieldGate canary-only does not hold a PEM body', async () => {
  const gate = await createProgressiveYieldGate({ context: ctx(FIXED_CANARY) });
  gate.process(`-----BEGIN PRIVATE KEY-----\n${'p'.repeat(200)}`);
  assertEquals(gate.unreleased(), '');
});

Deno.test('a gate with nothing to read for releases every fragment as it comes', async () => {
  const gate = await createProgressiveYieldGate({ context: ctx() });
  assertEquals(gate.process(''), { blocked: false, emit: '' });
  assertEquals(gate.process('x'), { blocked: false, emit: 'x' });
  assertEquals(gate.unreleased(), '');
});

Deno.test('a canary-shaped tail is held from where it begins in the unreleased text', async () => {
  const canary = mintCanary();
  const gate = await createProgressiveYieldGate({ context: ctx(canary) });
  assertEquals(gate.process('w'.repeat(50)), { blocked: false, emit: 'w'.repeat(50) });
  assertEquals(gate.process(canary.slice(0, 4)), { blocked: false, emit: '' });
  assertEquals(gate.unreleased(), canary.slice(0, 4));
});

Deno.test('draining the unreleased tail takes only what was not yet released, and flush then adds nothing', async () => {
  const canary = 'b8d3e3616fea1b7bfcb0bfb750bffe3d';
  const opening = canary.slice(0, 4);
  const gate = await createProgressiveYieldGate({ context: ctx(canary) });
  assertEquals(gate.process(`Here: ${opening}`), { blocked: false, emit: 'Here: ' });
  assertEquals(gate.drainUnreleased(), opening);
  assertEquals(gate.unreleased(), '');
  assertEquals(gate.flush(), { blocked: false, emit: '' });
  assertEquals(gate.accumulated(), `Here: ${opening}`);
});

Deno.test('createProgressiveYieldGate reads the carry in front of its window', async () => {
  const canary = mintCanary();
  const half = CANARY_OPENING;
  const first = await createProgressiveYieldGate({ context: ctx(canary) });
  // No letters or digits in the lead-in: they could extend the opening in some reading.
  assertEquals(first.process(`>> ${canary.slice(0, half)}`), {
    blocked: false,
    emit: '>> ',
  });
  assertEquals(first.flush().blocked, false);
  // The next window of the same canary completes the token: one match.
  const second = await createProgressiveYieldGate({
    context: ctx(canary),
    carry: first.carryOut(),
  });
  assertEquals(second.process(canary.slice(half)).blocked, true);
});

Deno.test('createProgressiveYieldGate holds a window opening that continues the carry', async () => {
  const canary = 'abcdef0123456789abcdef0123456789';
  const gate = await createProgressiveYieldGate({ context: ctx(canary), carry: 'abcdef' });
  // "0123" continues the carried opening, so it is held; "5" breaks it, so "zz, 5" goes.
  assertEquals(gate.process('0123'), { blocked: false, emit: '' });
  const other = await createProgressiveYieldGate({ context: ctx(canary), carry: 'abcdef' });
  assertEquals(other.process('zz, 5'), { blocked: false, emit: 'zz, 5' });
});

Deno.test('createProgressiveYieldGate carries only the tail that could open a leak', async () => {
  const gate = await createProgressiveYieldGate({ context: ctx(FIXED_CANARY) });
  gate.process('nothing to carry here');
  assertEquals(gate.carryOut(), 're');
  assertEquals((await createProgressiveYieldGate({ context: ctx() })).carryOut(), '');
});

Deno.test('createProgressiveYieldGate releases a three-character opening and blocks the leak it grows into', async () => {
  const canary = 'b8d3e3616fea1b7bfcb0bfb750bffe3d';
  const gate = await createProgressiveYieldGate({ context: ctx(canary) });
  // Shorter than an opening the hold keeps back: it goes out.
  assertEquals(gate.process(`Here: ${canary.slice(0, 3)}`), {
    blocked: false,
    emit: `Here: ${canary.slice(0, 3)}`,
  });
  // The rest of the token still reads as one leak with what was released.
  const next = gate.process(canary.slice(3));
  assertEquals(next.blocked, true);
});

Deno.test('createProgressiveYieldGate holds a four-character opening', async () => {
  const canary = 'b8d3e3616fea1b7bfcb0bfb750bffe3d';
  const gate = await createProgressiveYieldGate({ context: ctx(canary) });
  assertEquals(gate.process(`Here: ${canary.slice(0, 4)}`), {
    blocked: false,
    emit: 'Here: ',
  });
  assertEquals(gate.process(canary.slice(4)).blocked, true);
});

Deno.test('createProgressiveYieldGate carries a released short opening into the next window', async () => {
  const canary = 'b8d3e3616fea1b7bfcb0bfb750bffe3d';
  const first = await createProgressiveYieldGate({ context: ctx(canary) });
  assertEquals(first.process(`Here: ${canary.slice(0, 3)}`), {
    blocked: false,
    emit: `Here: ${canary.slice(0, 3)}`,
  });
  assertEquals(first.flush(), { blocked: false, emit: '' });
  // Three released characters and fifteen more make one sixteen-character run.
  const next = await createProgressiveYieldGate({ context: ctx(canary), carry: first.carryOut() });
  assertEquals(next.process(canary.slice(3, 18)).blocked, true);
});

const SYSTEM = [
  'You are Sol, the support agent for Northwind Outfitters.',
  'Only discuss orders, returns, and shipping; never mention internal tooling.',
  'Escalate refunds above 200 dollars to a human and apologise once, briefly.',
].join(' ');
const ECHO = SYSTEM.split(' ').slice(3, 16).join(' ');

/** A reply gate whose leak detectors stand as `leaks` sets them at `reply`. */
async function leakGate(leaks: DetectSpec, context: GuardrailContext) {
  return await createProgressiveYieldGate({
    context: { ...context, privateSystem: [SYSTEM] },
    detect: { matrix: resolveDetect(leaks), boundary: 'reply', rewrite: true },
  });
}

/** What a gate releases of `text` once the stream ends, or that it stopped. */
function released(gate: Awaited<ReturnType<typeof leakGate>>, text: string) {
  const steps = [gate.process(text), gate.flush()];
  if (steps.some((step) => step.blocked)) return 'blocked';
  return steps.map((step) => (step.blocked ? '' : step.emit)).join('');
}

const leakRules = (result: ReturnType<Awaited<ReturnType<typeof leakGate>>['process']>) =>
  result.blocked ? result.hits.map(({ rule }) => rule) : [];

Deno.test('a gate stops on the canary and on the prompt echo as its matrix sets them at its boundary', async () => {
  const canary = mintCanary();
  const spec: DetectSpec = {
    canary_leak: { at: { reply: 'block' } },
    prompt_leak: { at: { reply: 'block' } },
  };
  const leaked = await leakGate(spec, ctx(canary));
  assertEquals(leakRules(leaked.process(`it is ${canary}`)), [DETECT_RULES.canary_leak]);
  const echoed = await leakGate(spec, ctx(canary));
  assertEquals(leakRules(echoed.process(`Sure: ${ECHO} and more`)), [DETECT_RULES.prompt_leak]);
});

Deno.test('a gate reads a leak set to ignore at its boundary as no leak', async () => {
  const canary = mintCanary();
  const canaryOff = await leakGate(
    { canary_leak: { at: { reply: 'ignore' } }, prompt_leak: { at: { reply: 'block' } } },
    ctx(canary),
  );
  assertEquals(released(canaryOff, `it is ${canary}`), `it is ${canary}`);
  const promptOff = await leakGate(
    { canary_leak: { at: { reply: 'block' } }, prompt_leak: { at: { reply: 'ignore' } } },
    ctx(canary),
  );
  const text = `Sure: ${ECHO} and more`;
  assertEquals(released(promptOff, text), text);
});

Deno.test('a gate does not stop on a canary the turn was given', async () => {
  const canary = mintCanary();
  const gate = await leakGate(
    { canary_leak: { at: { reply: 'block' } } },
    { ...ctx(canary), canaryGiven: true },
  );
  assertEquals(released(gate, `it is ${canary}`), `it is ${canary}`);
});

Deno.test('a gate reports a leak set to flag once, and releases the text', async () => {
  const canary = mintCanary();
  const gate = await leakGate({ canary_leak: { at: { reply: 'flag' } } }, ctx(canary));
  const first = gate.process(`one ${canary} two `);
  assertEquals(first.blocked, false);
  assertEquals(first.blocked ? [] : first.found?.hits.map(({ rule }) => rule), [
    DETECT_RULES.canary_leak,
  ]);
  const again = gate.process(`${canary} three`);
  const rest = gate.flush();
  const reported = [again, rest].flatMap((step) =>
    step.blocked ? [] : (step.found?.hits ?? []).map(({ rule }) => rule),
  );
  assertEquals(reported, []);
});

Deno.test('a gate with no matrix stops on both leaks', async () => {
  const canary = mintCanary();
  const gate = await createProgressiveYieldGate({
    context: { ...ctx(canary), privateSystem: [SYSTEM] },
  });
  assertEquals(leakRules(gate.process(`it is ${canary}`)), [DETECT_RULES.canary_leak]);
  const echoed = await createProgressiveYieldGate({
    context: { ...ctx(canary), privateSystem: [SYSTEM] },
  });
  assertEquals(leakRules(echoed.process(`Sure: ${ECHO} and more`)), [DETECT_RULES.prompt_leak]);
});
